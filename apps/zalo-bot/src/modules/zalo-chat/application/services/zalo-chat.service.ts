import { Injectable, Logger } from '@nestjs/common';
import { Inject, Optional } from '@nestjs/common';
import {
  buildConsentChangedMessage,
  buildGreetingMessage,
  buildSelfIntroMessage,
  buildUnsupportedMessageTypeReply,
  parseConsentCommand,
  type ConsentCommand,
} from '@wispace/bot-common/messages';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { ConfigService } from '@nestjs/config';
import { NotificationPreferenceService } from '@wispace/database';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '@wispace/study-reminder-shared';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { PlatformChatQueueService } from '@wispace/chat-agent';
import {
  isValidApprovalToken,
  RescheduleConfirmationService,
} from '@wispace/reschedule-confirm';
import {
  RESCHEDULE_CONFIRM_KEYWORDS,
  RESCHEDULE_CANCEL_KEYWORDS,
} from '../constants/zalo-reschedule.constants';
import {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  IntentDetector,
} from '@wispace/llm-agent';

@Injectable()
export class ZaloChatService {
  private readonly logger = new Logger(ZaloChatService.name);
  private readonly intentDetector = new IntentDetector();
  private readonly oauthAuthorizeUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly outboundService: ZaloOutboundService,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly chatQueueService: PlatformChatQueueService,
    private readonly rescheduleConfirmationService: RescheduleConfirmationService<string>,
    private readonly notificationPreferences: NotificationPreferenceService,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository?: StudyReminderJobRepositoryPort,
  ) {
    const appId = this.configService.get<string>('ZALO_APP_ID');
    const redirectUri = this.configService.get<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );
    this.oauthAuthorizeUrl =
      appId && redirectUri
        ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
        : '';
  }

  async handleIncomingMessage(
    zaloUserId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void> {
    // Intent detection: greeting/self-intro → reply directly, skip LLM
    const intent = this.intentDetector.detect(text.trim());
    if (intent.intent === 'greeting') {
      await this.outboundService.sendText(zaloUserId, buildGreetingMessage());
      return;
    }
    if (intent.intent === 'self_intro') {
      await this.outboundService.sendText(zaloUserId, buildSelfIntroMessage());
      return;
    }

    // Consent commands (#596): deterministic, never through the LLM or quota.
    const consentCommand = parseConsentCommand(text.trim());
    if (consentCommand) {
      await this.handleConsentCommand(zaloUserId, consentCommand);
      return;
    }

    try {
      const identity =
        await this.accountLinkService.findCurrentIdentity?.(zaloUserId);
      const userId =
        identity?.userId ??
        (await this.accountLinkService.findUserIdByZaloId(zaloUserId));

      const hasPending =
        await this.rescheduleConfirmationService.hasPending(zaloUserId);

      if (hasPending && this.isConfirmKeyword(text.trim())) {
        if (!identity) {
          await this.outboundService.sendText(
            zaloUserId,
            'Mình không thể xác thực liên kết WISPACE hiện tại. Bạn liên kết lại rồi thử lại nhé.',
          );
          return;
        }
        const approvalToken = this.readApprovalToken(text.trim());
        const result = approvalToken
          ? await this.rescheduleConfirmationService.confirm(
              zaloUserId,
              userId,
              approvalToken,
              {
                platform: 'zalo',
                mappingVersion: identity?.mappingVersion,
              },
            )
          : await this.rescheduleConfirmationService.confirm(
              zaloUserId,
              userId,
            );
        if (result.confirmed) {
          await this.outboundService.sendText(
            zaloUserId,
            `Đã dời buổi học sang ${result.scheduledTimeLabel} nhé.`,
          );
          return;
        }
        await this.outboundService.sendText(zaloUserId, result.message);
        return;
      }

      if (hasPending && this.isCancelKeyword(text.trim())) {
        const message =
          await this.rescheduleConfirmationService.cancel(zaloUserId);
        await this.outboundService.sendText(zaloUserId, message);
        return;
      }

      const key = idempotencyKey ?? `zalo:${zaloUserId}:${Date.now()}`;
      await this.chatQueueService.enqueue(zaloUserId, text, { userId }, key);
    } catch (error) {
      this.logger.error(
        `Chat enqueue failed for zaloUserId=${maskExternalId(
          zaloUserId,
        )}: ${maskExternalIdInText(errorMessage(error), zaloUserId)}`,
      );
      try {
        await this.outboundService.sendText(
          zaloUserId,
          CHAT_FAILURE_FALLBACK_MESSAGE,
        );
      } catch {
        // ignore
      }
      throw error;
    }
  }

  private async handleConsentCommand(
    zaloUserId: string,
    command: ConsentCommand,
  ): Promise<void> {
    const userId = await this.accountLinkService.findUserIdByZaloId(zaloUserId);
    if (userId === undefined) {
      await this.outboundService.sendText(
        zaloUserId,
        'Bạn cần liên kết tài khoản WISPACE trước khi bật/tắt báo cáo và nhắc học nhé.',
      );
      return;
    }

    const enable = command.action === 'enable';
    if (command.feature === 'report') {
      await this.notificationPreferences.setReportEnabled(userId, enable);
      if (enable) {
        await this.accountLinkService
          .suppressOptOutNotice(zaloUserId)
          .catch(() => undefined);
      }
    } else {
      await this.notificationPreferences.setReminderEnabled(userId, enable);
      if (!enable) {
        const cancelled =
          (await this.studyReminderJobRepository?.cancelPendingJobsForExternalUser(
            'zalo',
            zaloUserId,
          )) ?? 0;
        this.logger.log(
          `Reminder opt-out cancelled ${cancelled} jobs for zaloUserId=${maskExternalId(
            zaloUserId,
          )}`,
        );
      }
    }

    await this.outboundService.sendText(
      zaloUserId,
      buildConsentChangedMessage(command.feature, enable),
    );
  }

  private isConfirmKeyword(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    return (
      RESCHEDULE_CONFIRM_KEYWORDS.includes(normalized) ||
      (normalized.startsWith('xác nhận ') &&
        isValidApprovalToken(normalized.slice('xác nhận '.length)))
    );
  }

  private readApprovalToken(text: string): string | undefined {
    const token = text.slice('xác nhận '.length).trim();
    return isValidApprovalToken(token) ? token : undefined;
  }

  private isCancelKeyword(text: string): boolean {
    return RESCHEDULE_CANCEL_KEYWORDS.includes(text.toLowerCase());
  }

  async handleFollow(zaloUserId: string): Promise<void> {
    const linkPart = this.oauthAuthorizeUrl
      ? `\n\nLiên kết tài khoản tại đây: ${this.oauthAuthorizeUrl}`
      : '';
    const message = `${buildGreetingMessage()}${linkPart}`;
    await this.outboundService.sendText(zaloUserId, message);
  }

  async handleUnsupportedMessage(zaloUserId: string): Promise<void> {
    await this.outboundService.sendText(
      zaloUserId,
      buildUnsupportedMessageTypeReply(),
    );
  }
}
