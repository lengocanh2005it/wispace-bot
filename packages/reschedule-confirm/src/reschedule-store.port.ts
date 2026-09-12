import { randomUUID } from 'crypto';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';

export interface PendingRescheduleRecord<TExternalId> {
  externalId: TExternalId;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
  sessionLabel: string;
  expiresAt: number;
  /** Lease token assigned at claim time — required for ownership-gated revert/cancel. */
  leaseToken?: string;
  /** Capability/approval binding fields persisted with the staged request. */
  toolName?: string;
  platform?: string;
  mappingVersion?: string;
  intentHash?: string;
  argsHash?: string;
  nonce?: string;
}

export interface RescheduleApprovalBinding {
  platform?: string;
  mappingVersion?: string;
  intentHash?: string;
  argsHash?: string;
  nonce?: string;
}

export type RescheduleCancellationOutcome =
  | 'cancelled'
  | 'none'
  | 'processing'
  | 'expired';

export type ReschedulePendingState =
  | 'pending'
  | 'processing'
  | 'expired'
  | 'none';

/**
 * Persistence for staged reschedule confirmations. The in-memory default is
 * per-instance (a restart or a second pod loses the pending confirmation);
 * apps pass a DB-backed implementation for production.
 */
export interface RescheduleStorePort<TExternalId> {
  /** Production stores require the opaque token carried by the UI action. */
  readonly requiresApprovalToken?: boolean;
  /** Returns false when an in-flight confirmation prevents replacement. */
  save(
    pending: PendingRescheduleRecord<TExternalId>,
    options?: { signal?: AbortSignal },
  ): Promise<boolean>;
  /** Atomically claims a valid (unexpired) pending confirmation for the user. */
  takeValid(
    externalId: TExternalId,
    userId?: number,
    binding?: RescheduleApprovalBinding,
  ): Promise<PendingRescheduleRecord<TExternalId> | null>;
  /** Puts a claimed record back to pending (confirm failed — user can retry). */
  revertToPending(externalId: TExternalId, leaseToken: string): Promise<void>;
  /** Deletes a user-cancelled row, optionally guarded by its staging nonce. */
  cancelPending(
    externalId: TExternalId,
    nonce?: string,
  ): Promise<RescheduleCancellationOutcome>;
  /** Deletes only the row still owned by the claimed lease. */
  cancelClaimed(externalId: TExternalId, leaseToken: string): Promise<void>;
  /** Returns and lazily removes the current proposal state. */
  getPendingState?(externalId: TExternalId): Promise<ReschedulePendingState>;
  hasPending(externalId: TExternalId): Promise<boolean>;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 10_000;

interface MemoryEntry<TExternalId> {
  record: PendingRescheduleRecord<TExternalId>;
  claimed: boolean;
}

/** Default per-instance store — same semantics as the old in-memory map. */
export class MemoryRescheduleStore<
  TExternalId,
> implements RescheduleStorePort<TExternalId> {
  private readonly pendingByExternalId = new Map<
    string,
    MemoryEntry<TExternalId>
  >();

  save(
    pending: PendingRescheduleRecord<TExternalId>,
    _options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    const key = String(pending.externalId);
    if (this.pendingByExternalId.get(key)?.claimed) {
      return Promise.resolve(false);
    }
    if (!this.pendingByExternalId.has(key)) {
      this.prune();
      if (this.pendingByExternalId.size >= MAX_PENDING) {
        const oldestEvictableKey = Array.from(
          this.pendingByExternalId.entries(),
        ).find(([, entry]) => !entry.claimed)?.[0];
        if (oldestEvictableKey === undefined) {
          return Promise.resolve(false);
        }
        this.pendingByExternalId.delete(oldestEvictableKey);
      }
    }
    this.pendingByExternalId.set(key, { record: pending, claimed: false });
    return Promise.resolve(true);
  }

  takeValid(
    externalId: TExternalId,
    userId?: number,
    binding?: RescheduleApprovalBinding,
  ): Promise<PendingRescheduleRecord<TExternalId> | null> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (!entry || entry.claimed) {
      return Promise.resolve(null);
    }

    if (entry.record.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(key);
      return Promise.resolve(null);
    }

    if (userId != null && entry.record.userId !== userId) {
      return Promise.resolve(null);
    }
    if (
      binding &&
      ((binding.platform && entry.record.platform !== binding.platform) ||
        (binding.mappingVersion &&
          entry.record.mappingVersion !== binding.mappingVersion) ||
        (binding.intentHash &&
          entry.record.intentHash !== binding.intentHash) ||
        (binding.argsHash && entry.record.argsHash !== binding.argsHash) ||
        (binding.nonce && entry.record.nonce !== binding.nonce))
    ) {
      return Promise.resolve(null);
    }

    entry.record.leaseToken = randomUUID();
    entry.claimed = true;
    return Promise.resolve(entry.record);
  }

  revertToPending(externalId: TExternalId, leaseToken: string): Promise<void> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (entry?.claimed && entry.record.leaseToken === leaseToken) {
      entry.claimed = false;
      entry.record.expiresAt = Date.now() + PENDING_TTL_MS;
    }
    return Promise.resolve();
  }

  cancelPending(
    externalId: TExternalId,
    nonce?: string,
  ): Promise<RescheduleCancellationOutcome> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (!entry) {
      return Promise.resolve('none');
    }
    if (entry.claimed) {
      return Promise.resolve('processing');
    }
    if (nonce !== undefined && entry.record.nonce !== nonce) {
      return Promise.resolve('none');
    }
    if (entry.record.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(key);
      return Promise.resolve('none');
    }
    this.pendingByExternalId.delete(key);
    return Promise.resolve('cancelled');
  }

  cancelClaimed(externalId: TExternalId, leaseToken: string): Promise<void> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (entry?.claimed && entry.record.leaseToken === leaseToken) {
      this.pendingByExternalId.delete(key);
    }
    return Promise.resolve();
  }

  hasPending(externalId: TExternalId): Promise<boolean> {
    return this.getPendingState(externalId).then(
      (state) => state === 'pending',
    );
  }

  getPendingState(externalId: TExternalId): Promise<ReschedulePendingState> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (!entry || entry.claimed) {
      return Promise.resolve(entry?.claimed ? 'processing' : 'none');
    }
    if (entry.record.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(key);
      return Promise.resolve('expired');
    }
    return Promise.resolve('pending');
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingByExternalId) {
      if (!entry.claimed && entry.record.expiresAt <= now) {
        this.pendingByExternalId.delete(key);
      }
    }
  }
}
