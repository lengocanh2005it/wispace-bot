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
}

/**
 * Persistence for staged reschedule confirmations. The in-memory default is
 * per-instance (a restart or a second pod loses the pending confirmation);
 * apps pass a DB-backed implementation for production.
 */
export interface RescheduleStorePort<TExternalId> {
  save(pending: PendingRescheduleRecord<TExternalId>): Promise<void>;
  /** Atomically claims a valid (unexpired) pending confirmation for the user. */
  takeValid(
    externalId: TExternalId,
    userId?: number,
  ): Promise<PendingRescheduleRecord<TExternalId> | null>;
  /** Puts a claimed record back to pending (confirm failed — user can retry). */
  revertToPending(externalId: TExternalId, leaseToken?: string): Promise<void>;
  cancel(externalId: TExternalId, leaseToken?: string): Promise<void>;
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

  save(pending: PendingRescheduleRecord<TExternalId>): Promise<void> {
    const key = String(pending.externalId);
    if (!this.pendingByExternalId.has(key)) {
      this.prune();
      if (this.pendingByExternalId.size >= MAX_PENDING) {
        const oldestKey = Array.from(this.pendingByExternalId.keys())[0];
        if (oldestKey !== undefined) {
          this.pendingByExternalId.delete(oldestKey);
        }
      }
    }
    this.pendingByExternalId.set(key, { record: pending, claimed: false });
    return Promise.resolve();
  }

  takeValid(
    externalId: TExternalId,
    userId?: number,
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

    entry.claimed = true;
    return Promise.resolve(entry.record);
  }

  revertToPending(
    externalId: TExternalId,
    _leaseToken?: string,
  ): Promise<void> {
    const key = String(externalId);
    const entry = this.pendingByExternalId.get(key);
    if (entry) {
      entry.claimed = false;
      entry.record.expiresAt = Date.now() + PENDING_TTL_MS;
    }
    return Promise.resolve();
  }

  cancel(externalId: TExternalId, _leaseToken?: string): Promise<void> {
    this.pendingByExternalId.delete(String(externalId));
    return Promise.resolve();
  }

  hasPending(externalId: TExternalId): Promise<boolean> {
    const entry = this.pendingByExternalId.get(String(externalId));
    if (!entry || entry.claimed) {
      return Promise.resolve(false);
    }
    if (entry.record.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(String(externalId));
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingByExternalId) {
      if (entry.record.expiresAt <= now || entry.claimed) {
        this.pendingByExternalId.delete(key);
      }
    }
  }
}
