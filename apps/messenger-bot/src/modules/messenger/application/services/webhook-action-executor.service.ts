import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildConsentChangedMessage,
  buildGreetingMessage,
} from '@wispace/bot-common/messages';
import { maskExternalId } from '@wispace/bot-common/masking';
import { NotificationPreferenceService } from '@wispace/database';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '@wispace/study-reminder-shared';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { UserDisplayNameService } from '@messenger/modules/display-name/application/user-display-name.service';
import { getStudyReminderLeadTimeNotice } from '@messenger/modules/study-reminder/application/messages/study-reminder.messages';
import { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import { MessengerChatEnqueueService } from './messenger-chat-enqueue.service';
import { MessengerMappingService } from './messenger-mapping.service';
import { MessengerLinkContextService } from './messenger-link-context.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { MessengerRescheduleConfirmationService } from './messenger-reschedule-confirmation.service';
import { buildMessengerLinkVerifyFailedMessage } from '../messages/messenger-link.messages';
import { buildRescheduleSuccessRichFollowUp } from '../formatters/messenger-rich-message.builder';
import type {
  MessengerLinkAttemptResult,
  MessengerLinkVerifyFailureReason,
} from '../../domain/types/messenger-link-verify.types';
import { MessengerReportDeliveryService } from './messenger-report-delivery.service';
import { MessengerReminderDeliveryService } from './messenger-reminder-delivery.service';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import {
  extractRefFromEvent,
  WebhookAction,
} from '../messenger-webhook.router';
import type { ConsentCommand } from '@wispace/bot-common/messages';

@Injectable()
export class WebhookActionExecutorService {
  private readonly logger = new Logger(WebhookActionExecutorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerMappingService: MessengerMappingService,
    private readonly messengerLinkContextService: MessengerLinkContextService,
    private readonly messengerChatQueueService: MessengerChatEnqueueService,
    private readonly reportDeliveryService: MessengerReportDeliveryService,
    private readonly reminderDeliveryService: MessengerReminderDeliveryService,
    private readonly userDisplayNameService: UserDisplayNameService,
    private readonly rescheduleConfirmationService: MessengerRescheduleConfirmationService,
    private readonly notificationPreferences: NotificationPreferenceService,
    @Optional()
    @Inject(STUDY_REMINDER_JOB_REPOSITORY)
    private readonly studyReminderJobRepository?: StudyReminderJobRepositoryPort,
    @Optional()
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository?: MessengerMappingRepositoryPort,
  ) {}

  async executeAction(
    action: WebhookAction,
    event: MessengerWebhookEvent,
    resolveLinkContextForChat: (
      psid: string,
      event: MessengerWebhookEvent,
    ) => Promise<MessengerLinkContext | undefined>,
  ): Promise<void> {
    const psid = action.type === 'ignore' ? event.sender?.id : action.psid;

    switch (action.type) {
      case 'ignore':
        if (psid) {
          this.logger.log(`Ignored event for PSID ${maskExternalId(psid)}`);
        }
        break;

      case 'link_user': {
        const linkAttempt = await this.attemptLinkFromEvent(
          psid!,
          event,
          action.context,
        );
        if (linkAttempt.status === 'linked' && linkAttempt.context) {
          this.logger.log(
            `Linked PSID ${maskExternalId(psid)} from opt-in (topic=${linkAttempt.context.topic}, cadence=${linkAttempt.context.cadence})`,
          );
        } else if (!extractRefFromEvent(event)) {
          this.logger.warn(
            `Opt-in for PSID ${maskExternalId(psid)} missing ref, topic or cadence`,
          );
        }
        break;
      }

      case 'enqueue_chat': {
        const linkContext = await resolveLinkContextForChat(psid!, event);
        await this.messengerChatQueueService.enqueue({
          psid: psid!,
          userId: action.userId,
          userText: action.userText,
          linkContext,
          idempotencyKey: action.idempotencyKey,
        });
        break;
      }

      case 'send_text':
        // Await delivery: a failure must propagate so the durable inbox
        // worker marks the event failed and the retry cron replays it —
        // completing the event before Meta accepted the send would drop
        // the message with no recovery record.
        await this.outbound.sendTextViaPsid({
          psid: psid!,
          userId: action.userId,
          text: action.text,
          messageType: action.messageType,
        });
        break;

      case 'register_report':
        await this.reportDeliveryService.registerForScheduledReports(
          psid!,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
          action as any,
        );
        break;

      case 'send_report':
        await this.reportDeliveryService.sendReport(psid!, action.userId);
        break;

      case 'send_reminder_preview':
        await this.reminderDeliveryService.sendReminderPreview(
          psid!,
          action.userId,
        );
        break;

      case 'confirm_reschedule':
        await this.handleConfirmReschedulePostback(
          psid!,
          action.userId,
          action.approvalToken,
        );
        break;

      case 'cancel_reschedule': {
        const message = await this.rescheduleConfirmationService.cancel(psid!);
        await this.outbound.sendTextViaPsid({
          psid: psid!,
          userId: action.userId,
          text: message,
          messageType: 'RESCHEDULE_CANCELLED',
        });
        break;
      }

      case 'consent_command':
        await this.handleConsentCommand(psid!, action.userId, action.command);
        break;

      case 'send_welcome':
        await this.outbound.sendTextViaPsid({
          psid: psid!,
          userId: action.userId,
          text: await this.buildWelcomeMessage(psid!, action.userId),
          messageType: 'WELCOME',
        });
        break;
    }
  }

  private async handleConsentCommand(
    psid: string,
    userId: number,
    command: ConsentCommand,
  ): Promise<void> {
    const mapping =
      await this.messengerRepository?.findActiveMappingByPsid(psid);
    const consentUserId = mapping?.userId ?? userId;
    if (consentUserId == null) {
      await this.outbound.sendTextViaPsid({
        psid,
        text: 'Bạn cần liên kết tài khoản WISPACE trước khi bật/tắt báo cáo và nhắc học nhé.',
        messageType: 'CONSENT_NOT_LINKED',
      });
      return;
    }

    const enable = command.action === 'enable';
    if (command.feature === 'report') {
      await this.notificationPreferences.setReportEnabled(
        consentUserId,
        enable,
      );
      if (enable) {
        // The Messenger report cron gates on cadence/topic — fill the
        // subscription record so the consent flag actually delivers (#596).
        await this.messengerRepository?.ensureReportSubscription(psid);
      } else {
        // Clearing cadence/topic stops the cron immediately, on top of the
        // user-level consent flag.
        await this.messengerRepository?.clearReportSubscription(psid);
      }
    } else {
      await this.notificationPreferences.setReminderEnabled(
        consentUserId,
        enable,
      );
      if (!enable) {
        await this.studyReminderJobRepository?.cancelPendingJobsForExternalUser(
          'messenger',
          psid,
        );
      }
    }

    await this.outbound.sendTextViaPsid({
      psid,
      userId: consentUserId,
      text: buildConsentChangedMessage(command.feature, enable),
      messageType: 'CONSENT_UPDATED',
    });
  }

  private async attemptLinkFromEvent(
    psid: string,
    event: MessengerWebhookEvent,
    verifiedContext?: MessengerLinkContext,
  ): Promise<MessengerLinkAttemptResult> {
    // #383: when the router hands over a pre-verified context, write it
    // directly — the single-use token was already consumed during pre-resolve.
    if (verifiedContext) {
      const linked = await this.linkPsidFromContext(psid, verifiedContext);
      return linked
        ? { status: 'linked', context: verifiedContext }
        : { status: 'blocked' };
    }

    const ref = extractRefFromEvent(event);
    if (!ref) {
      return { status: 'no_ref' };
    }

    const outcome = await this.messengerLinkContextService.resolveFromRef(
      psid,
      {
        ref,
        topic: event.optin?.topic,
        cadence: event.optin?.frequency,
      },
    );

    if (outcome.verifyFailureReason) {
      await this.notifyMessengerLinkVerifyFailure(
        psid,
        outcome.verifyFailureReason,
      );
      return { status: 'verify_failed' };
    }

    if (!outcome.context) {
      return { status: 'invalid_ref' };
    }

    const linked = await this.linkPsidFromContext(psid, outcome.context);
    if (linked) {
      return { status: 'linked', context: outcome.context };
    }

    return { status: 'blocked' };
  }

  private async notifyMessengerLinkVerifyFailure(
    psid: string,
    reason: MessengerLinkVerifyFailureReason,
  ): Promise<void> {
    await this.outbound
      .sendTextViaPsid({
        psid,
        text: buildMessengerLinkVerifyFailedMessage(reason),
        messageType: 'MESSENGER_LINK_VERIFY_FAILED',
      })
      .catch(() => undefined);
  }

  private async linkPsidFromContext(
    psid: string,
    context: MessengerLinkContext,
  ): Promise<boolean> {
    const result = await this.messengerMappingService.linkFromContext(
      psid,
      context,
    );
    return !result.blocked;
  }

  private async handleConfirmReschedulePostback(
    psid: string,
    userId?: number,
    approvalToken?: string,
  ): Promise<void> {
    const mapping =
      await this.messengerRepository?.findActiveMappingByPsid(psid);
    const currentUserId = mapping?.userId;
    if (currentUserId == null) {
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: 'Không thể xác thực liên kết WISPACE hiện tại. Bạn liên kết lại rồi thử lại nhé.',
        messageType: 'RESCHEDULE_CONFIRM_FAILED',
      });
      return;
    }
    const result = approvalToken
      ? await this.rescheduleConfirmationService.confirm(
          psid,
          currentUserId,
          approvalToken,
          {
            platform: 'messenger',
            mappingVersion: mapping
              ? `${mapping.id}:${mapping.updatedAt}`
              : undefined,
          },
        )
      : await this.rescheduleConfirmationService.confirm(psid, currentUserId);

    if (!result.confirmed) {
      await this.outbound.sendTextViaPsid({
        psid,
        userId: currentUserId,
        text: result.message,
        messageType: 'RESCHEDULE_CONFIRM_FAILED',
      });
      return;
    }

    await this.outbound.sendTextViaPsid({
      psid,
      userId: currentUserId,
      text: [
        `Mình đã dời buổi học sang ${result.scheduledTimeLabel} cho bạn rồi nhé ✅`,
        getStudyReminderLeadTimeNotice(
          this.configService.get<number>('STUDY_REMINDER_MINUTES_BEFORE') ?? 30,
        ),
      ].join('\n\n'),
      messageType: 'RESCHEDULE_CONFIRMED',
    });

    await this.outbound.sendRichFollowUps({
      psid,
      userId: currentUserId,
      followUps: [
        buildRescheduleSuccessRichFollowUp({
          scheduledTimeLabel: result.scheduledTimeLabel,
        }),
      ],
    });
  }

  private async buildWelcomeMessage(
    psid: string,
    userId?: number,
  ): Promise<string> {
    const displayName = await this.userDisplayNameService.resolveDisplayName({
      psid,
      userId,
    });
    return buildGreetingMessage(displayName);
  }
}
