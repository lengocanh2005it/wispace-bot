import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common';
import {
  ChatRateLimitCore,
  todayUsageDate,
  type ChatQuotaCheckResult,
} from '@wispace/chat-metering';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import { ChatQuotaEventRecorderService } from './chat-quota-event-recorder.service';
import {
  CHAT_BURST_COUNTER,
  type ChatBurstCounterPort,
} from '../../domain/repositories/chat-burst-counter.port';
import {
  CHAT_QUOTA_REPOSITORY,
  type ChatQuotaRepositoryPort,
} from '../../domain/repositories/chat-quota.repository.port';

/**
 * Thin Messenger adapter around the shared `ChatRateLimitCore`.
 *
 * Adds Messenger-specific cross-cutting concerns on top of the core quota
 * engine: whitelist bypass, Prometheus metrics, and quota event audit trail.
 * All quota algorithm logic lives in the shared core — this class owns only
 * the Messenger-specific hooks.
 */
@Injectable()
export class ChatRateLimitService {
  private readonly logger = new Logger(ChatRateLimitService.name);
  private readonly core: ChatRateLimitCore;

  constructor(
    private readonly configService: ChatRateLimitConfigService,
    @Inject(CHAT_QUOTA_REPOSITORY)
    private readonly repository: ChatQuotaRepositoryPort,
    @Inject(CHAT_BURST_COUNTER)
    private readonly burstCounter: ChatBurstCounterPort,
    private readonly quotaEventRecorder: ChatQuotaEventRecorderService,
    private readonly metrics: MetricsService,
  ) {
    const settings = this.configService.getSettings();
    this.core = new ChatRateLimitCore(
      {
        getDailyUsageCount: (id, date) =>
          this.repository.getDailyUsageCount(id, date),
        reserveFreeFormSlotInTransaction: (input) =>
          this.repository.reserveFreeFormSlotInTransaction({
            psid: input.externalUserId,
            userId: input.userId,
            usageDate: input.usageDate,
            idempotencyKey: input.idempotencyKey,
            dailyLimit: input.dailyLimit,
            burstLimit: input.burstLimit,
            burstSince: input.burstSince,
            burstCountsRefunded: input.burstCountsRefunded,
          }),
        refundReservedSlot: (params) =>
          this.repository.refundReservedSlot({
            psid: params.externalUserId,
            usageDate: params.usageDate,
            idempotencyKey: params.idempotencyKey,
            releaseReason: params.releaseReason,
            userId: params.userId,
          }),
        completeReservedSlot: (key) =>
          this.repository.completeReservedSlot(key),
        markDeliveredSlot: (key) => this.repository.markDeliveredSlot(key),
        recoverIdempotencyForRetry: (key, cutoff) =>
          this.repository.recoverIdempotencyForRetry(key, cutoff),
        recoverAllStuckReserved: (cutoff) =>
          this.repository.recoverAllStuckReserved(cutoff),
      },
      this.burstCounter,
      {
        freeFormDailyLimit: settings.freeFormDailyLimit,
        burstPerMinute: settings.burstPerMinute,
        timezone: settings.timezone,
        burstCountsRefunded: settings.burstCountsRefunded,
      },
      {
        warn: () => undefined,
        log: () => undefined,
      },
      this.configService.getStuckReservedMs(),
    );
  }

  async reserveFreeFormSlot(
    psid: string,
    params: { userId?: number; idempotencyKey: string },
  ): Promise<ChatQuotaCheckResult> {
    // Whitelist bypass — no quota enforcement
    if (!this.configService.shouldEnforceForPsid(psid)) {
      const { freeFormDailyLimit, timezone } = this.configService.getSettings();
      const usageDate = todayUsageDate(timezone);
      const used = this.configService.isEnabled()
        ? await this.repository.getDailyUsageCount(psid, usageDate)
        : 0;
      return {
        allowed: true,
        used,
        limit: freeFormDailyLimit,
        remaining: Math.max(freeFormDailyLimit - used, 0),
        usageDate,
        quotaReserved: false,
      };
    }

    const result = await this.core.reserveFreeFormSlot(psid, params);

    // Record denied events (outside the core's transaction boundary)
    if (!result.allowed && result.reason) {
      this.metrics.incQuotaDenied(result.reason);
      this.logQuotaDeny(result.reason, psid, params.idempotencyKey, result);
      this.quotaEventRecorder.recordDeniedBestEffort({
        psid,
        userId: params.userId,
        usageDate: result.usageDate,
        reason: result.reason as 'DAILY_LIMIT' | 'BURST_LIMIT',
        limit: result.limit,
        used: result.used,
      });
    }

    return result;
  }

  async refundFreeFormSlot(
    psid: string,
    usageDate: string,
    idempotencyKey: string,
    options?: { userId?: number },
  ): Promise<void> {
    if (!this.configService.shouldEnforceForPsid(psid)) {
      return;
    }
    await this.core.refundFreeFormSlot(
      psid,
      usageDate,
      idempotencyKey,
      options,
    );
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    if (!this.configService.isEnabled()) {
      return;
    }
    await this.core.markCompleted(idempotencyKey);
  }

  async markDelivered(idempotencyKey: string): Promise<void> {
    if (!this.configService.isEnabled()) {
      return;
    }
    await this.core.markDelivered(idempotencyKey);
  }

  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    if (!this.configService.isEnabled()) {
      return { recovered: [] };
    }
    return this.core.recoverStuckReservedSlots();
  }

  // Reason is narrowed to 'DAILY_LIMIT' | 'BURST_LIMIT' at the call site —
  // the core never returns 'NOT_LINKED' or 'IDEMPOTENCY_CONFLICT' here.
  private logQuotaDeny(
    reason: string,
    psid: string,
    idempotencyKey: string,
    result: ChatQuotaCheckResult,
  ): void {
    this.logger.warn(
      `CHAT_QUOTA_DENY reason=${reason} psid=${maskExternalId(psid)} mid=${idempotencyKey} used=${result.used} limit=${result.limit}`,
    );
  }
}
