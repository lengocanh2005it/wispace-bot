import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessengerLinkContext,
  buildWelcomeMessage,
} from '../../../../shared/config/poc.constants';
import { UserDisplayNameService } from '../../../study-reminder/application/services/user-display-name.service';
import { getStudyReminderLeadTimeNotice } from '../../../study-reminder/application/messages/study-reminder.messages';
import { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import { MessengerChatQueueService } from './messenger-chat-queue.service';
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
import { WebhookAction } from '../messenger-webhook.router';

@Injectable()
export class WebhookActionExecutorService {
  private readonly logger = new Logger(WebhookActionExecutorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerMappingService: MessengerMappingService,
    private readonly messengerLinkContextService: MessengerLinkContextService,
    private readonly messengerChatQueueService: MessengerChatQueueService,
    private readonly reportDeliveryService: MessengerReportDeliveryService,
    private readonly reminderDeliveryService: MessengerReminderDeliveryService,
    private readonly userDisplayNameService: UserDisplayNameService,
    private readonly rescheduleConfirmationService: MessengerRescheduleConfirmationService,
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
          this.logger.log(`Ignored event for PSID ${psid}`);
        }
        break;

      case 'link_user': {
        const linkAttempt = await this.attemptLinkFromEvent(psid!, event);
        if (linkAttempt.status === 'linked' && linkAttempt.context) {
          this.logger.log(
            `Linked PSID ${psid} from opt-in (ref=${linkAttempt.context.ref}, topic=${linkAttempt.context.topic}, cadence=${linkAttempt.context.cadence})`,
          );
        } else if (!this.extractRefFromEvent(event)) {
          this.logger.warn(
            `Opt-in for PSID ${psid} missing ref, topic or cadence`,
          );
        }
        break;
      }

      case 'enqueue_chat': {
        const linkContext = await resolveLinkContextForChat(psid!, event);
        this.messengerChatQueueService.enqueue({
          psid: psid!,
          userId: action.userId,
          userText: action.userText,
          linkContext,
          idempotencyKey: action.idempotencyKey,
        });
        break;
      }

      case 'send_text':
        void this.outbound
          .sendTextViaPsid({
            psid: psid!,
            userId: action.userId,
            text: action.text,
            messageType: action.messageType,
          })
          .catch(() => undefined);
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
        await this.handleConfirmReschedulePostback(psid!, action.userId);
        break;

      case 'cancel_reschedule': {
        const message = this.rescheduleConfirmationService.cancel(psid!);
        await this.outbound.sendTextViaPsid({
          psid: psid!,
          userId: action.userId,
          text: message,
          messageType: 'RESCHEDULE_CANCELLED',
        });
        break;
      }

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

  extractRefFromEvent(event: MessengerWebhookEvent): string | undefined {
    return (
      event.referral?.ref ??
      event.postback?.referral?.ref ??
      event.message?.referral?.ref ??
      event.optin?.ref
    );
  }

  private async attemptLinkFromEvent(
    psid: string,
    event: MessengerWebhookEvent,
  ): Promise<MessengerLinkAttemptResult> {
    const ref = this.extractRefFromEvent(event);
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
  ): Promise<void> {
    const result = await this.rescheduleConfirmationService.confirm(
      psid,
      userId,
    );

    if (!result.confirmed) {
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: result.message,
        messageType: 'RESCHEDULE_CONFIRM_FAILED',
      });
      return;
    }

    await this.outbound.sendTextViaPsid({
      psid,
      userId,
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
      userId,
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
    return buildWelcomeMessage(displayName);
  }
}
