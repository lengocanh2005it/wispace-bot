/**
 * Durable record of a reschedule whose calendar mutation has been attempted.
 *
 * The staged request cannot hold this: it is a single slot per learner and its
 * save path overwrites whatever is there. This is append-only and keyed by the
 * approval token the learner actually acted on, so a later request can never
 * destroy an earlier one's proof. See `CONTEXT.md` — *committed confirmation*
 * and *unknown-outcome attempt*.
 */
export type RescheduleAttemptStatus = 'attempting' | 'confirmed';

/**
 * `deferred` means a clean non-delivery that the recovery cron will retry.
 * `ambiguous` is deliberately absent from the retry set: the learner may already
 * have the message, and a later replay resolves it, so it is never re-sent
 * automatically.
 */
export type RescheduleNotificationStatus =
  | 'pending'
  | 'deferred'
  | 'delivered'
  | 'ambiguous'
  | 'abandoned';

/**
 * Re-exported from the owning package rather than redeclared here: per ADR-0043
 * the outbound delivery taxonomy is cross-context vocabulary, so
 * `@wispace/contracts` owns it.
 */
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
export type RescheduleNotificationOutcome = OutboundDeliveryOutcome;

export interface RescheduleAttemptRecord {
  externalId: string;
  nonce: string;
  platform: string;
  userId: number;
  status: RescheduleAttemptStatus;
  scheduledTimeLabel: string | null;
  notificationStatus: RescheduleNotificationStatus;
  notificationAttempts: number;
  nextNotificationAttemptAt: Date | null;
}

export interface BeginAttemptInput {
  externalId: string;
  nonce: string;
  userId: number;
}

/**
 * #1507: the attempt store is bound to one platform rather than reading it from
 * each row. `reschedule_confirmation_attempts` is a single shared table with a
 * shared advisory lock, so a store that could write or scan another platform's
 * rows would let the messenger transport send a Discord id to Meta. Binding the
 * platform here makes that impossible to express rather than merely discouraged.
 */
export interface RescheduleAttemptStorePort {
  /** Records that a calendar mutation is about to be attempted. */
  beginAttempt(input: BeginAttemptInput): Promise<void>;
  /**
   * Records that the mutation returned successfully. Returns false when no
   * attempt row exists, which the caller must treat as an unknown outcome.
   */
  confirmAttempt(input: {
    externalId: string;
    nonce: string;
    scheduledTimeLabel: string;
  }): Promise<boolean>;
  /** Removes the attempt row after a mutation that provably did not commit. */
  clearAttempt(externalId: string, nonce: string): Promise<void>;
  findAttempt(
    externalId: string,
    nonce: string,
  ): Promise<RescheduleAttemptRecord | null>;
  /**
   * Confirmed mutations whose confirmation this platform's learner has not
   * received. Scoped to the store's own platform (#1507).
   */
  listDueNotificationAttempts(
    limit: number,
    now: Date,
  ): Promise<RescheduleAttemptRecord[]>;
  markNotificationDelivered(externalId: string, nonce: string): Promise<void>;
  markNotificationAmbiguous(externalId: string, nonce: string): Promise<void>;
  /** Schedules another bounded attempt at the confirmation. */
  deferNotification(
    externalId: string,
    nonce: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  markNotificationAbandoned(externalId: string, nonce: string): Promise<void>;
}

export const MAX_NOTIFICATION_ATTEMPTS = 5;
export const NOTIFICATION_RETRY_MS = 5 * 60_000;

export function notificationIsDue(
  record: RescheduleAttemptRecord,
  now: Date,
): boolean {
  return (
    record.notificationStatus === 'deferred' &&
    record.notificationAttempts < MAX_NOTIFICATION_ATTEMPTS &&
    (record.nextNotificationAttemptAt === null ||
      record.nextNotificationAttemptAt.getTime() <= now.getTime())
  );
}

/**
 * The single place an outbound outcome becomes a record transition, shared by
 * the first delivery and the recovery-cron replay so the bound is enforced
 * once. `ambiguous` is never scheduled for retry: the learner may already hold
 * the message, and a later tap or replay resolves it.
 */
export async function applyNotificationOutcome(
  store: RescheduleAttemptStorePort,
  externalId: string,
  nonce: string,
  outcome: RescheduleNotificationOutcome,
  now: Date,
): Promise<void> {
  const record = await store.findAttempt(externalId, nonce);
  if (!record || record.status !== 'confirmed') {
    return;
  }
  if (outcome === 'sent') {
    await store.markNotificationDelivered(externalId, nonce);
    return;
  }
  if (outcome === 'ambiguous') {
    await store.markNotificationAmbiguous(externalId, nonce);
    return;
  }
  if (record.notificationAttempts >= MAX_NOTIFICATION_ATTEMPTS) {
    await store.markNotificationAbandoned(externalId, nonce);
    return;
  }
  await store.deferNotification(
    externalId,
    nonce,
    new Date(now.getTime() + NOTIFICATION_RETRY_MS),
  );
}

/**
 * Default per-instance store, matching the staged-request store's semantics:
 * a restart or a second pod loses it, so production wires the TypeORM adapter.
 */
export class MemoryRescheduleAttemptStore implements RescheduleAttemptStorePort {
  private readonly byKey = new Map<string, RescheduleAttemptRecord>();

  constructor(private readonly platform: string) {}

  private key(externalId: string, nonce: string): string {
    return `${externalId}:${nonce}`;
  }

  beginAttempt(input: BeginAttemptInput): Promise<void> {
    this.byKey.set(this.key(input.externalId, input.nonce), {
      externalId: input.externalId,
      nonce: input.nonce,
      platform: this.platform,
      userId: input.userId,
      status: 'attempting',
      scheduledTimeLabel: null,
      notificationStatus: 'pending',
      notificationAttempts: 0,
      nextNotificationAttemptAt: null,
    });
    return Promise.resolve();
  }

  confirmAttempt(input: {
    externalId: string;
    nonce: string;
    scheduledTimeLabel: string;
  }): Promise<boolean> {
    const record = this.byKey.get(this.key(input.externalId, input.nonce));
    if (!record) {
      return Promise.resolve(false);
    }
    record.status = 'confirmed';
    record.scheduledTimeLabel = input.scheduledTimeLabel;
    return Promise.resolve(true);
  }

  clearAttempt(externalId: string, nonce: string): Promise<void> {
    this.byKey.delete(this.key(externalId, nonce));
    return Promise.resolve();
  }

  findAttempt(
    externalId: string,
    nonce: string,
  ): Promise<RescheduleAttemptRecord | null> {
    return Promise.resolve(this.byKey.get(this.key(externalId, nonce)) ?? null);
  }

  listDueNotificationAttempts(
    limit: number,
    now: Date,
  ): Promise<RescheduleAttemptRecord[]> {
    return Promise.resolve(
      Array.from(this.byKey.values())
        .filter(
          (record) =>
            record.platform === this.platform &&
            record.status === 'confirmed' &&
            notificationIsDue(record, now),
        )
        .slice(0, limit),
    );
  }

  markNotificationDelivered(externalId: string, nonce: string): Promise<void> {
    const record = this.byKey.get(this.key(externalId, nonce));
    if (record) {
      record.notificationStatus = 'delivered';
      record.notificationAttempts += 1;
      record.nextNotificationAttemptAt = null;
    }
    return Promise.resolve();
  }

  markNotificationAmbiguous(externalId: string, nonce: string): Promise<void> {
    const record = this.byKey.get(this.key(externalId, nonce));
    if (record) {
      record.notificationStatus = 'ambiguous';
      record.notificationAttempts += 1;
      record.nextNotificationAttemptAt = null;
    }
    return Promise.resolve();
  }

  deferNotification(
    externalId: string,
    nonce: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    const record = this.byKey.get(this.key(externalId, nonce));
    if (record) {
      record.notificationStatus = 'deferred';
      record.notificationAttempts += 1;
      record.nextNotificationAttemptAt = nextAttemptAt;
    }
    return Promise.resolve();
  }

  markNotificationAbandoned(externalId: string, nonce: string): Promise<void> {
    const record = this.byKey.get(this.key(externalId, nonce));
    if (record) {
      record.notificationStatus = 'abandoned';
      record.nextNotificationAttemptAt = null;
    }
    return Promise.resolve();
  }
}
