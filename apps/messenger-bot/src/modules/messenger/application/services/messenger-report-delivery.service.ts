import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskExternalId } from '@wispace/bot-common';
import { StudentReportService } from '@messenger/modules/student-report/application/services/student-report.service';
import { StudentReportRetryableError } from '@messenger/modules/student-report/domain/errors/wispace-api.error';
import { buildStudentReportApiRetryMessage } from '@messenger/modules/student-report/application/messages/student-report.messages';
import { readMessengerBubbleLimits } from '../utils/messenger-bubble-config.utils';
import {
  isProactiveMessenger24hError,
  ProactiveMessenger24hSkippedError,
} from '../utils/proactive-send.utils';
import { MessengerOutboundService } from './messenger-outbound.service';
import { MessengerMappingService } from './messenger-mapping.service';
import type { UserMessengerMapping } from '../../domain/entities/messenger.types';
import {
  getPocAlreadySubscribedMessage,
  getPocSubscriptionConfirmationMessage,
} from '@messenger/shared/config/poc.constants';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

@Injectable()
export class MessengerReportDeliveryService {
  private readonly logger = new Logger(MessengerReportDeliveryService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly outbound: MessengerOutboundService,
    private readonly studentReportService: StudentReportService,
    private readonly mappingService: MessengerMappingService,
  ) {}

  async sendReportForMapping(mapping: UserMessengerMapping): Promise<string> {
    if (!mapping.psid) {
      throw new InternalServerErrorException(
        `Mapping ${mapping.id} has no PSID for Send API delivery`,
      );
    }

    return this.sendReportCore(
      mapping.psid,
      mapping.userId,
      'SCHEDULED_LEARNING_REPORT',
    );
  }

  async sendReport(psid: string, userId?: number): Promise<string> {
    try {
      return await this.sendReportCore(psid, userId, 'LEARNING_PROGRESS');
    } catch (error) {
      if (error instanceof StudentReportRetryableError) {
        const retryMessage = buildStudentReportApiRetryMessage();
        await this.sendReportBubbles({
          psid,
          userId,
          text: retryMessage,
          messageType: 'LEARNING_PROGRESS_API_DEFERRED',
        });
        return retryMessage;
      }

      throw error;
    }
  }

  async registerForScheduledReports(
    psid: string,
    context: MessengerLinkContext,
  ): Promise<void> {
    const existing = await this.repository.findActiveMappingByPsid(psid);

    if (
      existing?.cadence === context.cadence &&
      existing?.topic === context.topic
    ) {
      await this.outbound.sendTextViaPsid({
        psid,
        userId: existing.userId ?? context.userId,
        text: getPocAlreadySubscribedMessage(),
        messageType: 'SUBSCRIPTION_ALREADY_ACTIVE',
      });
      return;
    }

    const result = await this.mappingService.linkFromContext(psid, context, {
      notifyUser: false,
      syncStudyReminders: false,
    });

    if (result.blocked) {
      return;
    }

    this.logger.log(
      `Registered PSID ${maskExternalId(psid)} (userId=${maskExternalId(
        context.userId,
      )}, topic=${context.topic}, cadence=${context.cadence})`,
    );

    await this.outbound.sendTextViaPsid({
      psid,
      userId: context.userId,
      text: getPocSubscriptionConfirmationMessage(),
      messageType: 'SUBSCRIPTION_CONFIRMATION',
    });
  }

  private async sendReportCore(
    psid: string,
    userId: number | undefined,
    messageType: string,
  ): Promise<string> {
    try {
      const report = await this.studentReportService.generateReport(psid);
      await this.sendReportBubbles({ psid, userId, text: report, messageType });
      return report;
    } catch (error) {
      if (error instanceof ProactiveMessenger24hSkippedError) {
        return '';
      }

      throw error;
    }
  }

  private async sendReportBubbles(params: {
    psid: string;
    userId?: number;
    text: string;
    messageType: string;
  }): Promise<void> {
    const { maxBubbles, maxCharsPerBubble } = readMessengerBubbleLimits(
      this.configService,
    );

    try {
      await this.outbound.sendTextBubblesViaPsid({
        psid: params.psid,
        userId: params.userId,
        text: params.text,
        messageType: params.messageType,
        maxBubbles,
        maxCharsPerBubble,
      });
    } catch (error) {
      if (isProactiveMessenger24hError(error)) {
        this.logger.warn(
          `MESSENGER_24H_WINDOW psid=${maskExternalId(
            params.psid,
          )} messageType=${params.messageType}`,
        );
        throw new ProactiveMessenger24hSkippedError(
          params.psid,
          params.messageType,
        );
      }

      throw error;
    }
  }
}
