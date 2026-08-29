import type { MessengerWebhookEvent } from '../domain/entities/messenger.types';
import type { RouterContext } from './types/messenger-webhook-router.types';
import { isUnsupportedUserMessage } from '../domain/utils/webhook-predicates';
import {
  CONFIRM_RESCHEDULE_POSTBACK,
  CANCEL_RESCHEDULE_POSTBACK,
} from './constants/messenger-reschedule.constants';
import { IntentDetector } from '@wispace/llm-agent';
import {
  buildGreetingMessage,
  buildSelfIntroMessage,
  parseConsentCommand,
  type ConsentCommand,
} from '@wispace/bot-common/messages';
import {
  buildChatMissingMidMessage,
  buildUnsupportedMessageTypeReply,
} from './messages/chat-delivery.messages';
import {
  buildMappingRelinkBlockedMessage,
  buildMessengerLinkVerifyFailedMessage,
} from './messages/messenger-link.messages';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

const intentDetector = new IntentDetector();

export type WebhookAction =
  | {
      type: 'link_user';
      psid: string;
      ref: string;
      topic?: string;
      cadence?: string;
      /** Pre-verified context (#383) — executor skips re-verification. */
      context?: MessengerLinkContext;
    }
  | {
      type: 'enqueue_chat';
      psid: string;
      userId: number;
      userText: string;
      idempotencyKey?: string;
    }
  | {
      type: 'send_text';
      psid: string;
      userId?: number;
      text: string;
      messageType: string;
    }
  | {
      type: 'register_report';
      psid: string;
      userId: number;
      ref: string;
      topic: string;
      cadence: string;
    }
  | {
      type: 'send_report';
      psid: string;
      userId?: number;
    }
  | {
      type: 'send_reminder_preview';
      psid: string;
      userId?: number;
    }
  | {
      type: 'confirm_reschedule';
      psid: string;
      userId?: number;
      approvalToken?: string;
    }
  | {
      type: 'cancel_reschedule';
      psid: string;
      userId?: number;
      approvalToken?: string;
    }
  | {
      type: 'send_welcome';
      psid: string;
      userId?: number;
    }
  | {
      type: 'consent_command';
      psid: string;
      userId: number;
      command: ConsentCommand;
    }
  | { type: 'ignore' };

export type { RouterContext };

export function extractRefFromEvent(
  event: MessengerWebhookEvent,
): string | undefined {
  return (
    event.referral?.ref ??
    event.postback?.referral?.ref ??
    event.message?.referral?.ref ??
    event.optin?.ref
  );
}

function resolveLinkContext(ctx: RouterContext): {
  ref: string;
  topic: string;
  cadence: string;
  userId: number;
} | null {
  if (ctx.linkContext) {
    return ctx.linkContext;
  }
  return null;
}

export function routeWebhookEvent(
  event: MessengerWebhookEvent,
  ctx: RouterContext = {},
): WebhookAction[] {
  const psid = event.sender?.id;
  if (!psid) {
    return [{ type: 'ignore' }];
  }

  const refVerification = ctx.refVerification;

  // #383: one verified-link pipeline. Notices for blocked/failed refs are
  // emitted once per event for every Meta shape; link_user reuses the
  // pre-verified context so the single-use token is never submitted twice.
  const noticeActions: WebhookAction[] = [];
  if (refVerification?.status === 'blocked') {
    noticeActions.push({
      type: 'send_text',
      psid,
      userId: ctx.userId,
      text: buildMappingRelinkBlockedMessage(),
      messageType: 'MAPPING_RELINK_BLOCKED',
    });
  } else if (refVerification?.status === 'failed') {
    noticeActions.push({
      type: 'send_text',
      psid,
      text: buildMessengerLinkVerifyFailedMessage(
        refVerification.failureReason ?? 'NOT_FOUND',
      ),
      messageType: 'MESSENGER_LINK_VERIFY_FAILED',
    });
  }

  const linkAction: WebhookAction | undefined =
    refVerification?.status === 'verified' && refVerification.context
      ? {
          type: 'link_user',
          psid,
          ref: refVerification.context.ref,
          topic: event.optin?.topic,
          cadence: event.optin?.frequency,
          context: refVerification.context,
        }
      : undefined;

  const withRefActions = (actions: WebhookAction[]): WebhookAction[] => [
    ...(linkAction ? [linkAction] : []),
    ...noticeActions,
    ...actions,
  ];

  // --- Optin ---
  if (event.optin) {
    const ref = extractRefFromEvent(event);
    if (!ref) {
      return [{ type: 'ignore' }];
    }
    if (refVerification) {
      return linkAction ? [linkAction] : noticeActions;
    }
    return [
      {
        type: 'link_user',
        psid,
        ref,
        topic: event.optin.topic,
        cadence: event.optin.frequency,
      },
    ];
  }

  // --- Referral only (no postback, no text) ---
  if (event.referral?.ref && !event.postback && !event.message?.text) {
    if (refVerification) {
      return linkAction ? [linkAction] : noticeActions;
    }
    return [
      {
        type: 'link_user',
        psid,
        ref: event.referral.ref,
        topic: undefined,
        cadence: undefined,
      },
    ];
  }

  // --- Postback ---
  if (event.postback?.payload) {
    return withRefActions(routePostback(psid, event.postback.payload, ctx));
  }

  // --- Text message ---
  if (event.message?.text) {
    return withRefActions(routeTextMessage(psid, event.message, ctx));
  }

  // --- Unsupported message (sticker/attachment, no text) ---
  if (event.message && !event.message.is_echo) {
    if (isUnsupportedUserMessage(event.message)) {
      return withRefActions(routeUnsupportedMessage(psid, event.message, ctx));
    }
  }

  return noticeActions.length > 0 ? noticeActions : [{ type: 'ignore' }];
}

function routeTextMessage(
  psid: string,
  message: NonNullable<MessengerWebhookEvent['message']>,
  ctx: RouterContext,
): WebhookAction[] {
  if (message.is_echo) {
    return [{ type: 'ignore' }];
  }

  const messageMid = message.mid;

  if (!ctx.userId) {
    if (ctx.refVerification?.status === 'failed') {
      // The verify-failed notice was already emitted for this event (#383);
      // a MISSING_USER_REF reply would duplicate the same instruction.
      return [];
    }
    return [
      {
        type: 'send_text',
        psid,
        text: 'Vui lòng mở Messenger từ liên kết WISPACE (có đủ topic, cadence và ref) để kết nối tài khoản trước khi sử dụng.',
        messageType: 'MISSING_USER_REF',
      },
    ];
  }

  // Intent detection: greeting/self-intro → reply directly, skip LLM
  const intent = intentDetector.detect(message.text!.trim());
  if (intent.intent === 'greeting') {
    return [
      {
        type: 'send_text',
        psid,
        userId: ctx.userId,
        text: buildGreetingMessage(),
        messageType: 'GREETING',
      },
    ];
  }
  if (intent.intent === 'self_intro') {
    return [
      {
        type: 'send_text',
        psid,
        userId: ctx.userId,
        text: buildSelfIntroMessage(),
        messageType: 'SELF_INTRO',
      },
    ];
  }

  // Consent commands (#596): deterministic, never through the LLM or quota.
  const consentCommand = parseConsentCommand(message.text!.trim());
  if (consentCommand) {
    return [
      {
        type: 'consent_command',
        psid,
        userId: ctx.userId,
        command: consentCommand,
      },
    ];
  }

  if (!messageMid && ctx.shouldEnforceRateLimit) {
    return [
      {
        type: 'send_text',
        psid,
        userId: ctx.userId,
        text: buildChatMissingMidMessage(),
        messageType: 'CHAT_MISSING_MID',
      },
    ];
  }

  return [
    {
      type: 'enqueue_chat',
      psid,
      userId: ctx.userId,
      userText: message.text!.trim(),
      idempotencyKey: messageMid,
    },
  ];
}

function routeUnsupportedMessage(
  psid: string,
  message: NonNullable<MessengerWebhookEvent['message']>,
  ctx: RouterContext,
): WebhookAction[] {
  return [
    {
      type: 'send_text',
      psid,
      userId: ctx.userId,
      text: buildUnsupportedMessageTypeReply(),
      messageType: 'UNSUPPORTED_MESSAGE_TYPE',
    },
  ];
}

function routePostback(
  psid: string,
  payload: string,
  ctx: RouterContext,
): WebhookAction[] {
  const context = resolveLinkContext(ctx);
  const userId = ctx.userId;

  if (
    payload === 'GET_LEARNING_REPORT' ||
    payload === 'SEND_OPT_IN' ||
    payload === 'REGISTER_LEARNING_REPORT'
  ) {
    if (!context) {
      if (ctx.refVerification?.status === 'failed') {
        // Verify-failed notice already emitted (#383) — no duplicate reply.
        return [];
      }
      return [
        {
          type: 'send_text',
          psid,
          text: 'Vui lòng mở Messenger từ liên kết WISPACE (có đủ topic, cadence và ref) để kết nối tài khoản trước khi sử dụng.',
          messageType: 'MISSING_USER_REF',
        },
      ];
    }
    return [
      {
        type: 'register_report',
        psid,
        userId: context.userId,
        ref: context.ref,
        topic: context.topic,
        cadence: context.cadence,
      },
    ];
  }

  if (
    payload === 'VIEW_LEARNING_PROGRESS' ||
    payload === 'GET_LEARNING_PROGRESS'
  ) {
    return [{ type: 'send_report', psid, userId }];
  }

  if (
    payload === 'VIEW_UPCOMING_STUDY_SESSION' ||
    payload === 'PREVIEW_STUDY_REMINDER'
  ) {
    return [{ type: 'send_reminder_preview', psid, userId }];
  }

  if (
    payload === CONFIRM_RESCHEDULE_POSTBACK ||
    payload.startsWith(`${CONFIRM_RESCHEDULE_POSTBACK}:`)
  ) {
    return [
      {
        type: 'confirm_reschedule',
        psid,
        userId,
        ...(payload.includes(':')
          ? {
              approvalToken:
                payload.slice(CONFIRM_RESCHEDULE_POSTBACK.length + 1) ||
                undefined,
            }
          : {}),
      },
    ];
  }

  if (
    payload === CANCEL_RESCHEDULE_POSTBACK ||
    payload.startsWith(`${CANCEL_RESCHEDULE_POSTBACK}:`)
  ) {
    return [
      {
        type: 'cancel_reschedule',
        psid,
        userId,
        ...(payload.includes(':')
          ? {
              approvalToken:
                payload.slice(CANCEL_RESCHEDULE_POSTBACK.length + 1) ||
                undefined,
            }
          : {}),
      },
    ];
  }

  if (payload === 'GET_STARTED') {
    return [{ type: 'send_welcome', psid, userId }];
  }

  // Unknown postback — fallback to welcome (same as original behavior)
  return [{ type: 'send_welcome', psid, userId }];
}
