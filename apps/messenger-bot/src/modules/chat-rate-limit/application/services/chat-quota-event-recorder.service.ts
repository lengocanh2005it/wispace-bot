import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import type {
  ChatQuotaDenyReason,
  ChatQuotaReleaseReason,
} from '../../domain/entities/chat-quota-event.types';
import {
  CHAT_QUOTA_EVENT_REPOSITORY,
  type ChatQuotaEventRepositoryPort,
  type TransactionManager,
} from '../../domain/repositories/chat-quota-event.repository.port';
import { runInBackground } from '@messenger/shared/utils/run-in-background.utils';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';

@Injectable()
export class ChatQuotaEventRecorderService {
  private readonly logger = new Logger(ChatQuotaEventRecorderService.name);

  constructor(
    private readonly configService: ChatRateLimitConfigService,
    @Inject(CHAT_QUOTA_EVENT_REPOSITORY)
    private readonly eventRepository: ChatQuotaEventRepositoryPort,
  ) {}

  isEnabled(): boolean {
    return this.configService.isQuotaEventsEnabled();
  }

  async recordReservedInTransaction(
    manager: TransactionManager,
    input: {
      psid: string;
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      limit: number;
      usedAfter: number;
    },
  ): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.eventRepository.insertReservedInTransaction(manager, {
      psid: input.psid,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: input.idempotencyKey,
      payload: {
        limit: input.limit,
        used_after: input.usedAfter,
        idempotency_key: input.idempotencyKey,
      },
    });
  }

  async recordReleasedInTransaction(
    manager: TransactionManager,
    input: {
      psid: string;
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      reason: ChatQuotaReleaseReason;
      usedAfter: number;
    },
  ): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.eventRepository.insertReleasedInTransaction(manager, {
      psid: input.psid,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: `${input.idempotencyKey}:released`,
      reason: input.reason,
      payload: {
        reason: input.reason,
        used_after: input.usedAfter,
      },
    });
  }

  recordDeniedBestEffort(input: {
    psid: string;
    userId?: number;
    usageDate: string;
    reason: ChatQuotaDenyReason;
    limit: number;
    used: number;
  }): void {
    if (!this.isEnabled()) {
      return;
    }

    runInBackground(
      () =>
        this.eventRepository.insertDenied({
          psid: input.psid,
          userId: input.userId,
          usageDate: input.usageDate,
          payload: {
            reason: input.reason,
            limit: input.limit,
            used: input.used,
          },
        }),
      (error) => {
        this.logger.warn(
          `CHAT_QUOTA_EVENT_DENIED_INSERT_FAILED psid=${maskExternalId(input.psid)} reason=${input.reason}: ${errorMessage(
            error,
          )}`,
        );
      },
    );
  }
}
