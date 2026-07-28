import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';
import type { ChatRateLimitRepository } from './chat-rate-limit.repository';
import type { BurstCounterPort } from './types';

/**
 * Burst derived from `chat_idempotency` rows already written atomically by
 * `reserveFreeFormSlotInTransaction` — no separate increment needed, just
 * check the recent-reservation count against the limit.
 */
export class PostgresBurstCounter implements BurstCounterPort {
  constructor(
    private readonly repository: Pick<
      ChatRateLimitRepository,
      'countRecentReservations'
    >,
    private readonly includeRefunded = false,
  ) {}

  getBurstCount(externalUserId: string): Promise<number> {
    return this.repository.countRecentReservations(
      externalUserId,
      new Date(Date.now() - CHAT_BURST_WINDOW_MS),
      { includeRefunded: this.includeRefunded },
    );
  }

  async tryReserveBurst(
    externalUserId: string,
    limit: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const count = await this.getBurstCount(externalUserId);
    return { allowed: count < limit, count };
  }

  releaseReservation(_externalUserId: string): Promise<void> {
    void _externalUserId;
    return Promise.resolve();
  }
}
