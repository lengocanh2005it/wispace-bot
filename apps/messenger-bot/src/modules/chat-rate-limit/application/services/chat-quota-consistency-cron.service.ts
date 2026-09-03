import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisBurstReconciler } from '@wispace/chat-metering';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';

@Injectable()
export class ChatQuotaConsistencyCronService {
  private readonly logger = new Logger(ChatQuotaConsistencyCronService.name);

  constructor(
    private readonly config: ChatRateLimitConfigService,
    private readonly reconciler: RedisBurstReconciler,
  ) {}

  /** Audit the current Redis advisory bucket once per minute when enabled. */
  @Cron('*/60 * * * * *', {
    name: 'chat-quota-redis-consistency',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleConsistencyCheck(): Promise<void> {
    if (this.config.getBurstStore() !== 'redis') return;
    try {
      const result = await this.reconciler.reconcile();
      if (result.mismatches > 0 || result.unresolved > 0) {
        this.logger.warn(
          `chat-quota-redis-consistency status=${result.status} scanned=${result.scanned} mismatches=${result.mismatches} repaired=${result.repaired} unresolved=${result.unresolved} sampleExternalIds=${result.sampleExternalIds.join(',')}`,
        );
      }
    } catch (error) {
      // ponytail: one bounded pass per minute; the next tick retries after a
      // transient DB/Redis error and the metric/alert carries the signal.
      this.logger.error(`chat quota consistency failed: ${String(error)}`);
    }
  }
}
