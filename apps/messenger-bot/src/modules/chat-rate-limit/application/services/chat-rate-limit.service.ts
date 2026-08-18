import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common';
import type { ChatQuotaCheckResult } from '../../domain/entities/chat-quota.types';
import type { RecoverIdempotencyOutcome } from '../../domain/entities/chat-idempotency.types';
import {
  CHAT_QUOTA_REPOSITORY,
  type ChatQuotaRepositoryPort,
} from '../../domain/repositories/chat-quota.repository.port';
import {
  CHAT_BURST_COUNTER,
  type ChatBurstCounterPort,
} from '../../domain/repositories/chat-burst-counter.port';
import { todayUsageDate } from '@wispace/chat-metering';
import { subtractMs } from '@wispace/date-utils';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import { ChatQuotaEventRecorderService } from './chat-quota-event-recorder.service';

/**
 * Reserve runs before LLM (Phase 3 queue hook). Refund on LLM/Send failure.
 * Burst check runs before daily reserve (Phase 4).
 */
@Injectable()
export class ChatRateLimitService {
  private readonly logger = new Logger(ChatRateLimitService.name);

  constructor(
    private readonly configService: ChatRateLimitConfigService,
    @Inject(CHAT_QUOTA_REPOSITORY)
    private readonly repository: ChatQuotaRepositoryPort,
    @Inject(CHAT_BURST_COUNTER)
    private readonly burstCounter: ChatBurstCounterPort,
    private readonly quotaEventRecorder: ChatQuotaEventRecorderService,
    private readonly metrics: MetricsService,
  ) {}

  async reserveFreeFormSlot(
    psid: string,
    params: { userId?: number; idempotencyKey: string },
  ): Promise<ChatQuotaCheckResult> {
    const { freeFormDailyLimit, burstPerMinute, timezone } =
      this.configService.getSettings();
    const usageDate = todayUsageDate(timezone);

    if (!this.configService.shouldEnforceForPsid(psid)) {
      const used = this.configService.isEnabled()
        ? await this.repository.getDailyUsageCount(psid, usageDate)
        : 0;
      return this.buildBypassResult(used, freeFormDailyLimit, usageDate);
    }

    // Atomically check+increment burst counter. For Redis this uses a Lua script
    // to avoid the race where two concurrent requests both pass the read check.
    const burstResult = await this.burstCounter.tryReserveBurst(
      psid,
      burstPerMinute,
    );
    if (!burstResult.allowed) {
      this.metrics.incQuotaDenied('BURST_LIMIT');
      this.logQuotaDeny(
        'BURST_LIMIT',
        psid,
        params.idempotencyKey,
        burstResult.count,
        burstPerMinute,
      );
      this.quotaEventRecorder.recordDeniedBestEffort({
        psid,
        userId: params.userId,
        usageDate,
        reason: 'BURST_LIMIT',
        limit: burstPerMinute,
        used: burstResult.count,
      });
      return {
        allowed: false,
        used: burstResult.count,
        limit: burstPerMinute,
        remaining: 0,
        reason: 'BURST_LIMIT',
        usageDate,
        quotaReserved: false,
      };
    }

    return this.reserveAndRollbackBurstOnFailure(psid, {
      userId: params.userId,
      usageDate,
      idempotencyKey: params.idempotencyKey,
      freeFormDailyLimit,
      burstLimit: burstPerMinute,
    });
  }

  // Burst counter was already incremented by tryReserveBurst. Roll it back if the
  // DB reserve fails (daily limit, idempotency conflict) so the count stays accurate.
  private async reserveAndRollbackBurstOnFailure(
    psid: string,
    params: {
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      freeFormDailyLimit: number;
      burstLimit: number;
    },
  ): Promise<ChatQuotaCheckResult> {
    const outcome = await this.reserveSlotOrRecoverOnConflict(psid, {
      userId: params.userId,
      usageDate: params.usageDate,
      idempotencyKey: params.idempotencyKey,
      dailyLimit: params.freeFormDailyLimit,
    });

    if (outcome.status === 'burst_limit_exceeded') {
      await this.burstCounter.releaseReservation(psid);
      this.metrics.incQuotaDenied('BURST_LIMIT');
      this.logQuotaDeny(
        'BURST_LIMIT',
        psid,
        params.idempotencyKey,
        outcome.count,
        params.burstLimit,
      );
      return {
        allowed: false,
        used: outcome.count,
        limit: params.burstLimit,
        remaining: 0,
        reason: 'BURST_LIMIT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    if (outcome.status === 'daily_limit_exceeded') {
      await this.burstCounter.releaseReservation(psid);
      // Count is known to be >= dailyLimit — no need for a second DB read.
      const used = params.freeFormDailyLimit;
      this.metrics.incQuotaDenied('DAILY_LIMIT');
      this.logQuotaDeny(
        'DAILY_LIMIT',
        psid,
        params.idempotencyKey,
        used,
        params.freeFormDailyLimit,
      );
      this.quotaEventRecorder.recordDeniedBestEffort({
        psid,
        userId: params.userId,
        usageDate: params.usageDate,
        reason: 'DAILY_LIMIT',
        limit: params.freeFormDailyLimit,
        used,
      });
      return {
        allowed: false,
        used,
        limit: params.freeFormDailyLimit,
        remaining: 0,
        reason: 'DAILY_LIMIT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    if (outcome.status === 'idempotency_conflict') {
      await this.burstCounter.releaseReservation(psid);
      // Caller (processChatBatch) only checks quota.reason for IDEMPOTENCY_CONFLICT
      // and does not render used/remaining to the user — skip the extra DB read.
      return {
        allowed: false,
        used: 0,
        limit: params.freeFormDailyLimit,
        remaining: params.freeFormDailyLimit,
        reason: 'IDEMPOTENCY_CONFLICT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    // Burst already incremented — no separate recordReservation needed.
    return {
      allowed: true,
      used: outcome.freeFormCount,
      limit: params.freeFormDailyLimit,
      remaining: Math.max(params.freeFormDailyLimit - outcome.freeFormCount, 0),
      usageDate: params.usageDate,
      quotaReserved: true,
    };
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

    const refunded = await this.repository.refundReservedSlot({
      psid,
      usageDate,
      idempotencyKey,
      releaseReason: 'send_failed',
      userId: options?.userId,
    });

    if (refunded) {
      if (!this.configService.getBurstCountsRefunded()) {
        await this.burstCounter.releaseReservation(psid);
      }

      this.logger.warn(
        `CHAT_QUOTA_REFUND psid=${maskExternalId(psid)} mid=${idempotencyKey} usageDate=${usageDate}`,
      );
    }
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    if (!this.configService.isEnabled()) {
      return;
    }

    await this.repository.completeReservedSlot(idempotencyKey);
  }

  async markDelivered(idempotencyKey: string): Promise<void> {
    if (!this.configService.isEnabled()) {
      return;
    }

    await this.repository.markDeliveredSlot(idempotencyKey);
  }

  /** H2 ops: finalize delivered keys and refund stale pre-delivery keys. */
  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    if (!this.configService.isEnabled()) {
      return { recovered: [] };
    }

    const stuckBefore = this.stuckReservedCutoff();
    const recovered =
      await this.repository.recoverAllStuckReserved(stuckBefore);

    if (recovered.length > 0) {
      this.logger.warn(
        `CHAT_QUOTA_RECOVERED count=${recovered.length} keys=${recovered.join(',')}`,
      );
    }

    return { recovered };
  }

  private stuckReservedCutoff(): Date {
    return subtractMs(new Date(), this.configService.getStuckReservedMs());
  }

  private async reserveSlotOrRecoverOnConflict(
    psid: string,
    input: {
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      dailyLimit: number;
    },
  ) {
    let outcome = await this.repository.reserveFreeFormSlotInTransaction({
      psid,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: input.idempotencyKey,
      dailyLimit: input.dailyLimit,
    });

    if (
      outcome.status !== 'idempotency_conflict' &&
      outcome.status !== 'daily_limit_exceeded'
    ) {
      return outcome;
    }

    if (outcome.status === 'daily_limit_exceeded') {
      return outcome;
    }

    const recovery = await this.repository.recoverIdempotencyForRetry(
      input.idempotencyKey,
      this.stuckReservedCutoff(),
    );

    if (recovery === 'reopened') {
      this.logger.log(
        `Reopened idempotency mid=${input.idempotencyKey} psid=${maskExternalId(psid)} for retry (H2)`,
      );
      outcome = await this.repository.reserveFreeFormSlotInTransaction({
        psid,
        userId: input.userId,
        usageDate: input.usageDate,
        idempotencyKey: input.idempotencyKey,
        dailyLimit: input.dailyLimit,
      });
    } else {
      this.logIdempotencyConflict(input.idempotencyKey, psid, recovery);
    }

    return outcome;
  }

  private logIdempotencyConflict(
    idempotencyKey: string,
    psid: string,
    recovery: RecoverIdempotencyOutcome,
  ): void {
    if (recovery === 'in_flight') {
      this.logger.log(
        `Idempotency in flight mid=${idempotencyKey} psid=${maskExternalId(psid)}; skip duplicate flush`,
      );
      return;
    }

    if (recovery === 'completed') {
      this.logger.log(
        `Idempotency already completed mid=${idempotencyKey} psid=${maskExternalId(psid)}; skip duplicate flush`,
      );
      return;
    }

    if (recovery === 'delivered') {
      this.logger.log(
        `Idempotency delivery pending finalization mid=${idempotencyKey} psid=${maskExternalId(psid)}; skip duplicate flush`,
      );
    }
  }

  private logQuotaDeny(
    reason: 'DAILY_LIMIT' | 'BURST_LIMIT',
    psid: string,
    idempotencyKey: string,
    used: number,
    limit: number,
  ): void {
    this.logger.warn(
      `CHAT_QUOTA_DENY reason=${reason} psid=${maskExternalId(psid)} mid=${idempotencyKey} used=${used} limit=${limit}`,
    );
  }

  private buildBypassResult(
    used: number,
    limit: number,
    usageDate: string,
  ): ChatQuotaCheckResult {
    return {
      allowed: true,
      used,
      limit,
      remaining: Math.max(limit - used, 0),
      usageDate,
      quotaReserved: false,
    };
  }
}
