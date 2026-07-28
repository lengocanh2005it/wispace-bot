import type { BurstCounterPort } from './types';

export const CHAT_BURST_WINDOW_MS = 60_000;

export class MemoryBurstCounter implements BurstCounterPort {
  private readonly counts = new Map<string, number>();

  getBurstCount(externalUserId: string): Promise<number> {
    this.evictStaleBuckets();
    return Promise.resolve(
      this.counts.get(this.bucketKey(externalUserId)) ?? 0,
    );
  }

  // JS is single-threaded so this is inherently atomic.
  tryReserveBurst(
    externalUserId: string,
    limit: number,
  ): Promise<{ allowed: boolean; count: number }> {
    this.evictStaleBuckets();
    const key = this.bucketKey(externalUserId);
    const current = this.counts.get(key) ?? 0;
    if (current >= limit) {
      return Promise.resolve({ allowed: false, count: current });
    }
    const next = current + 1;
    this.counts.set(key, next);
    return Promise.resolve({ allowed: true, count: next });
  }

  releaseReservation(externalUserId: string): Promise<void> {
    const key = this.bucketKey(externalUserId);
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
    return Promise.resolve();
  }

  private bucketKey(externalUserId: string): string {
    return `${externalUserId}:${this.currentBucket()}`;
  }

  private currentBucket(): number {
    return Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
  }

  private evictStaleBuckets(): void {
    const current = this.currentBucket();

    for (const key of this.counts.keys()) {
      const bucket = Number(key.split(':').pop());
      if (!Number.isFinite(bucket) || bucket < current - 1) {
        this.counts.delete(key);
      }
    }
  }
}
