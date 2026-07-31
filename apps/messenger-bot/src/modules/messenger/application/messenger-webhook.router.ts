import type { MessengerWebhookEvent } from '../domain/entities/messenger.types';
import type { MessengerLinkAttemptStatus } from '../domain/types/messenger-link-verify.types';
import { isUnsupportedUserMessage } from './utils/webhook-message.utils';
import {
  CONFIRM_RESCHEDULE_POSTBACK,
  CANCEL_RESCHEDULE_POSTBACK,
} from './constants/messenger-reschedule.constants';
import { IntentDetector } from '@wispace/intent-detector';

export type WebhookAction =
  | {
      type: 'link_user';
      psid: string;
      ref: string;
      topic?: string;
      cadence?: string;
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
    }
  | {
      type: 'cancel_reschedule';
      psid: string;
      userId?: number;
    }
  | {
      type: 'send_welcome';
      psid: string;
      userId?: number;
    }
  | { type: 'ignore' };

export interface RouterContext {
  isDuplicateMid?: boolean;
  isDuplicatePostback?: boolean;
  userId?: number;
  linkContext?: {
    ref: string;
    topic: string;
    cadence: string;
    userId: number;
  } | null;
  linkAttemptStatus?: MessengerLinkAttemptStatus;
  shouldEnforceRateLimit?: boolean;
}

function linkAttemptBlocksWelcome(
  status?: MessengerLinkAttemptStatus,
): boolean {
  return status === 'blocked' || status === 'verify_failed';
}

function extractRefFromEvent(event: MessengerWebhookEvent): string | undefined {
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

  // --- Optin ---
  if (event.optin) {
    const ref = extractRefFromEvent(event);
    if (ref) {
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
    return [{ type: 'ignore' }];
  }

  // --- Referral only (no postback, no text) ---
  if (event.referral?.ref && !event.postback && !event.message?.text) {
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
    return routePostback(psid, event.postback.payload, ctx);
  }

  // --- Text message ---
  if (event.message?.text) {
    return routeTextMessage(psid, event.message, ctx);
  }

  // --- Unsupported message (sticker/attachment, no text) ---
  if (event.message && !event.message.is_echo) {
    if (isUnsupportedUserMessage(event.message)) {
      return routeUnsupportedMessage(psid, event.message, ctx);
    }
  }

  return [{ type: 'ignore' }];
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
  if (messageMid && ctx.isDuplicateMid) {
    return [{ type: 'ignore' }];
  }

  if (!ctx.userId) {
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
  const intentDetector = new IntentDetector();
  const intent = intentDetector.detect(message.text!.trim());
  if (intent.intent === 'greeting') {
    return [
      {
        type: 'send_text',
        psid,
        userId: ctx.userId,
        text: 'Chào bạn! 👋 Mình là trợ lý WISPACE — hỗ trợ bạn học IELTS Writing. Bạn có thể hỏi về lịch học, tiến độ hoặc mục tiêu band nhé!',
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
        text: 'Mình là WISPACE Bot — trợ lý AI hỗ trợ học IELTS Writing trên Messenger. Mình có thể giúp bạn xem lịch học, tiến độ và mục tiêu band. Gõ "hi" để bắt đầu! 🎓',
        messageType: 'SELF_INTRO',
      },
    ];
  }

  if (!messageMid && ctx.shouldEnforceRateLimit) {
    return [
      {
        type: 'send_text',
        psid,
        userId: ctx.userId,
        text: 'Mình chưa nhận diện được tin nhắn này. Bạn thử gửi lại một tin ngắn giúp mình nhé.',
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
  const messageMid = message.mid;
  if (messageMid && ctx.isDuplicateMid) {
    return [{ type: 'ignore' }];
  }

  return [
    {
      type: 'send_text',
      psid,
      userId: ctx.userId,
      text: 'Mình chỉ đọc được tin nhắn chữ thôi nhé. Bạn gửi lại câu hỏi bằng chữ để mình hỗ trợ bạn.',
      messageType: 'UNSUPPORTED_MESSAGE_TYPE',
    },
  ];
}

function routePostback(
  psid: string,
  payload: string,
  ctx: RouterContext,
): WebhookAction[] {
  if (ctx.isDuplicatePostback) {
    return [{ type: 'ignore' }];
  }

  const context = resolveLinkContext(ctx);
  const userId = ctx.userId;

  if (
    payload === 'GET_LEARNING_REPORT' ||
    payload === 'SEND_OPT_IN' ||
    payload === 'REGISTER_LEARNING_REPORT'
  ) {
    if (!context) {
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

  if (payload === CONFIRM_RESCHEDULE_POSTBACK) {
    return [{ type: 'confirm_reschedule', psid, userId }];
  }

  if (payload === CANCEL_RESCHEDULE_POSTBACK) {
    return [{ type: 'cancel_reschedule', psid, userId }];
  }

  if (payload === 'GET_STARTED') {
    if (linkAttemptBlocksWelcome(ctx.linkAttemptStatus)) {
      return [{ type: 'ignore' }];
    }
    return [{ type: 'send_welcome', psid, userId }];
  }

  // Unknown postback — fallback to welcome (same as original behavior)
  if (linkAttemptBlocksWelcome(ctx.linkAttemptStatus)) {
    return [{ type: 'ignore' }];
  }
  return [{ type: 'send_welcome', psid, userId }];
}
