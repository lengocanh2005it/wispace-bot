import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotMetricsService } from '@wispace/bot-metrics';
import { buildLinkSuccessMessage } from '@wispace/bot-common/messages';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import {
  ZALO_OUTBOUND,
  type ZaloOutboundPort,
} from '@zalo/modules/zalo-chat/application/ports/zalo-outbound.port';
import {
  readZaloRewelcomeWindowMs,
  readZaloWelcomeClaimMs,
} from '../../../../shared/config/zalo-link.config';
import {
  ZALO_WELCOME_RECORD_REPOSITORY,
  type ZaloWelcomeRecordRepositoryPort,
} from '../../domain/ports/zalo-welcome-record.repository.port';

export type ZaloWelcomeDeliveryOutcome = 'sent' | 'skipped' | 'error';

@Injectable()
export class ZaloWelcomeService {
  private readonly logger = new Logger(ZaloWelcomeService.name);

  constructor(
    @Inject(ZALO_WELCOME_RECORD_REPOSITORY)
    private readonly welcomeRecords: ZaloWelcomeRecordRepositoryPort,
    @Inject(ZALO_OUTBOUND) private readonly outbound: ZaloOutboundPort,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {}

  async welcomeIfDue(
    zaloUserId: string,
    userId?: number,
  ): Promise<ZaloWelcomeDeliveryOutcome> {
    return this.deliverIfDue(
      zaloUserId,
      userId,
      buildLinkSuccessMessage(),
      'linked',
    );
  }

  async organicWelcomeIfDue(
    zaloUserId: string,
    message: string,
  ): Promise<ZaloWelcomeDeliveryOutcome> {
    return this.deliverIfDue(zaloUserId, undefined, message, 'organic');
  }

  private async deliverIfDue(
    zaloUserId: string,
    userId: number | undefined,
    message: string,
    source: 'linked' | 'organic',
  ): Promise<ZaloWelcomeDeliveryOutcome> {
    const claimed = await this.welcomeRecords.tryClaimWelcome(
      zaloUserId,
      readZaloRewelcomeWindowMs(this.configService),
      readZaloWelcomeClaimMs(this.configService),
    );
    if (!claimed) {
      this.metrics?.incWelcomeAttempt('skipped');
      return 'skipped';
    }

    try {
      const outcome = await this.outbound.sendText(
        zaloUserId,
        message,
        userId === undefined ? undefined : { userId },
      );
      if (outcome !== 'sent') {
        this.metrics?.incWelcomeAttempt('error');
        return 'error';
      }
      await this.welcomeRecords.markWelcomed(zaloUserId, source);
      this.metrics?.incWelcomeAttempt('success');
      return 'sent';
    } catch (error) {
      this.metrics?.incWelcomeAttempt('error');
      this.logger.warn(
        `Zalo link welcome send failed for zaloUserId=${maskExternalId(zaloUserId)}: ${errorMessage(error, zaloUserId)}`,
      );
      return 'error';
    }
  }
}
