import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  buildConsentChangedMessage,
  buildGreetingMessage,
  buildNonDisclosureReply,
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
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { ZaloWelcomeService } from '@zalo/modules/zalo-oauth/application/services/zalo-welcome.service';
import { PlatformChatQueueService } from '@wispace/chat-agent';
import {
  isValidApprovalToken,
  RescheduleConfirmationService,
  RESCHEDULE_CONFIRM_TOKEN_REQUIRED_MESSAGE,
  RESCHEDULE_EXPIRED_MESSAGE,
  RESCHEDULE_INVALID_TOKEN_MESSAGE,
  type ReschedulePendingState,
} from '@wispace/reschedule-confirm';
import {
  RESCHEDULE_CONFIRM_KEYWORDS,
  RESCHEDULE_CANCEL_KEYWORDS,
} from '../constants/zalo-reschedule.constants';
import {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  IntentDetector,
  detectDisclosureProbe,
  isStopIntent,
} from '@wispace/llm-agent';
import {
  ZALO_OUTBOUND,
  type ZaloOutboundPort,
} from '../ports/zalo-outbound.port';
import {
  ZALO_CLARIFICATION_AGENT,
  type ZaloClarificationAgentPort,
} from '../ports/zalo-clarification-agent.port';

@Injectable()
export class ZaloChatService {
  private readonly logger = new Logger(ZaloChatService.name);
  private readonly intentDetector = new IntentDetector();
  private readonly oauthAuthorizeUrl: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(ZALO_OUTBOUND)
    private readonly outboundService: ZaloOutboundPort,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly chatQueueService: PlatformChatQueueService,
    private readonly rescheduleConfirmationService: RescheduleConfirmationService<string>,
    private readonly notificationPreferences: NotificationPreferenceService,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository?: StudyReminderJobRepositoryPort,
    @Optional() private readonly welcomeService?: ZaloWelcomeService,
    @Optional()
    @Inject(ZALO_CLARIFICATION_AGENT)
    private readonly clarificationAgent?: ZaloClarificationAgentPort,
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
    // Non-disclosure probe (#625): internal-details questions → standard
    // non-disclosure line, before intent detection.
    if (detectDisclosureProbe(text.trim()).probed) {
      await this.outboundService.sendText(
        zaloUserId,
        buildNonDisclosureReply(),
      );
      return;
    }

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

    let userId: number | undefined;
    try {
      const identity =
        await this.accountLinkService.findCurrentIdentity?.(zaloUserId);
      userId =
        identity?.userId ??
        (await this.accountLinkService.findUserIdByZaloId(zaloUserId));

      const interaction = this.parseRescheduleInteraction(text.trim());
      if (interaction) {
        const pendingState = await this.readPendingState(zaloUserId);

        if (pendingState !== 'none') {
          if (pendingState === 'expired') {
            if (interaction.kind === 'cancel') {
              await this.clarificationAgent
                ?.clearClarificationState(zaloUserId)
                .catch(() => undefined);
            }
            await this.outboundService.sendText(
              zaloUserId,
              RESCHEDULE_EXPIRED_MESSAGE,
              { userId },
            );
            return;
          }

          if (interaction.kind === 'cancel') {
            const message =
              await this.rescheduleConfirmationService.cancel(zaloUserId);
            await this.clarificationAgent
              ?.clearClarificationState(zaloUserId)
              .catch(() => undefined);
            await this.outboundService.sendText(zaloUserId, message, {
              userId,
            });
            return;
          }

          if (!interaction.approvalToken) {
            await this.outboundService.sendText(
              zaloUserId,
              RESCHEDULE_CONFIRM_TOKEN_REQUIRED_MESSAGE,
              { userId },
            );
            return;
          }
          if (!identity) {
            await this.outboundService.sendText(
              zaloUserId,
              'Mình không thể xác thực liên kết WISPACE hiện tại. Bạn liên kết lại rồi thử lại nhé.',
              { userId },
            );
            return;
          }
          const result = await this.rescheduleConfirmationService.confirm(
            zaloUserId,
            userId,
            interaction.approvalToken,
            {
              platform: 'zalo',
              mappingVersion: identity.mappingVersion,
            },
          );
          if (result.confirmed) {
            await this.outboundService.sendText(
              zaloUserId,
              `Đã dời buổi học sang ${result.scheduledTimeLabel} nhé.`,
              { userId },
            );
            return;
          }
          await this.outboundService.sendText(zaloUserId, result.message, {
            userId,
          });
          return;
        }

        if (
          interaction.kind === 'confirm' &&
          (interaction.approvalToken || interaction.invalid)
        ) {
          await this.outboundService.sendText(
            zaloUserId,
            RESCHEDULE_INVALID_TOKEN_MESSAGE,
            { userId },
          );
          return;
        }
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
          userId === undefined ? undefined : { userId },
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
      { userId },
    );
  }

  private parseRescheduleInteraction(
    text: string,
  ):
    | { kind: 'confirm'; approvalToken?: string; invalid?: boolean }
    | { kind: 'cancel' }
    | undefined {
    const normalized = text.toLowerCase().trim();
    if (
      RESCHEDULE_CANCEL_KEYWORDS.includes(normalized) ||
      isStopIntent(normalized)
    ) {
      return { kind: 'cancel' };
    }
    if (isValidApprovalToken(normalized)) {
      return { kind: 'confirm', approvalToken: normalized };
    }
    const firstToken = normalized.split(/\s+/, 1)[0];
    if (firstToken !== normalized && isValidApprovalToken(firstToken)) {
      return { kind: 'confirm', invalid: true };
    }
    if (RESCHEDULE_CONFIRM_KEYWORDS.includes(normalized)) {
      return { kind: 'confirm' };
    }
    for (const prefix of ['xác nhận', 'đồng ý']) {
      if (normalized.startsWith(`${prefix} `)) {
        const token = normalized.slice(prefix.length).trim();
        return {
          kind: 'confirm',
          ...(isValidApprovalToken(token)
            ? { approvalToken: token }
            : { invalid: true }),
        };
      }
    }
    if (
      /^(?:ok|oke|okay|yes|confirm|xác nhận|đồng ý)\s+/i.test(normalized) ||
      /^(?:mã|ma)\s*[:：]/i.test(normalized)
    ) {
      return {
        kind: 'confirm',
        ...(/^(?:mã|ma)\s*[:：]/i.test(normalized) ? { invalid: true } : {}),
      };
    }
    return undefined;
  }

  private async readPendingState(
    zaloUserId: string,
  ): Promise<ReschedulePendingState> {
    const getter = this.rescheduleConfirmationService.getPendingState;
    if (typeof getter === 'function') {
      return getter.call(this.rescheduleConfirmationService, zaloUserId);
    }
    return (await this.rescheduleConfirmationService.hasPending(zaloUserId))
      ? 'pending'
      : 'none';
  }

  async handleFollow(zaloUserId: string): Promise<void> {
    const linkPart = this.oauthAuthorizeUrl
      ? `\n\nLiên kết tài khoản tại đây: ${this.oauthAuthorizeUrl}`
      : '';
    const message = `${buildGreetingMessage()}${linkPart}`;
    if (this.welcomeService) {
      await this.welcomeService.organicWelcomeIfDue(zaloUserId, message);
      return;
    }
    await this.outboundService.sendText(zaloUserId, message);
  }

  async handleUnsupportedMessage(zaloUserId: string): Promise<void> {
    await this.outboundService.sendText(
      zaloUserId,
      buildUnsupportedMessageTypeReply(),
    );
  }
}
