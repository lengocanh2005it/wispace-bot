import {
  isGreetingOnly,
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '@wispace/llm-agent';
import { MessengerApiError } from '../services/messenger-outbound.service';
import { buildUnsupportedMessageTypeReply as buildSharedUnsupportedMessageTypeReply } from '@wispace/bot-common/messages';

/** Meta subcode for mark_seen / typing_on / react failures — not the 24h window. */
const MESSENGER_SENDER_ACTION_FAILED_SUBCODE = 2018048;

/** Meta subcode for messaging outside the standard 24-hour window. */
const MESSENGER_OUTSIDE_WINDOW_SUBCODE = 2018278;

const MESSAGING_WINDOW_TEXT_MARKERS = [
  'outside of the allowed window',
  'outside the allowed window',
  '24 hour',
  '24-hour',
  'messaging window',
] as const;

function parseMetaGraphError(responseBody: string): {
  code?: number;
  errorSubcode?: number;
  message?: string;
} | null {
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { code?: unknown; error_subcode?: unknown; message?: unknown };
    };
    const err = parsed.error;
    if (!err || typeof err !== 'object') {
      return null;
    }

    return {
      code: typeof err.code === 'number' ? err.code : undefined,
      errorSubcode:
        typeof err.error_subcode === 'number' ? err.error_subcode : undefined,
      message: typeof err.message === 'string' ? err.message : undefined,
    };
  } catch {
    return null;
  }
}

export function isMessengerSenderActionError(error: unknown): boolean {
  if (!(error instanceof MessengerApiError)) {
    return false;
  }

  const meta = parseMetaGraphError(error.responseBody);
  return meta?.errorSubcode === MESSENGER_SENDER_ACTION_FAILED_SUBCODE;
}

export function isMessenger24hWindowError(error: unknown): boolean {
  if (!(error instanceof MessengerApiError)) {
    return false;
  }

  if (isMessengerSenderActionError(error)) {
    return false;
  }

  const meta = parseMetaGraphError(error.responseBody);
  if (meta?.errorSubcode === MESSENGER_OUTSIDE_WINDOW_SUBCODE) {
    return true;
  }
  if (meta?.code === 10) {
    return true;
  }

  const haystack =
    `${error.message} ${meta?.message ?? ''} ${error.responseBody}`.toLowerCase();
  return MESSAGING_WINDOW_TEXT_MARKERS.some((marker) =>
    haystack.includes(marker.toLowerCase()),
  );
}

export function buildChatDeliveryErrorMessage(
  error: unknown,
  userText?: string,
): string {
  if (isMessenger24hWindowError(error)) {
    return (
      'Facebook chỉ cho phép bot trả lời trong vòng 24 giờ kể từ lần bạn nhắn gần nhất. ' +
      'Bạn mở lại cuộc chat với WISPACE và gửi một tin ngắn để tiếp tục nhé.'
    );
  }

  if (userText && isGreetingOnly(userText)) {
    return (
      'Chào bạn! Mình là trợ lý học tập WISPACE. Hiện mình đang gặp chút trục trặc, ' +
      'bạn thử nhắn lại sau ít phút để mình hỗ trợ bạn nhé.'
    );
  }

  if (isOpenAiRateLimitError(error)) {
    return 'Trợ lý AI đang quá tải, bạn thử lại sau 1–2 phút nhé.';
  }

  if (isOpenAiServerError(error)) {
    return 'Trợ lý AI tạm thời gặp sự cố, bạn thử lại sau giây lát nhé.';
  }

  return 'Xin lỗi, mình chưa xử lý được tin nhắn. Bạn thử gửi lại sau giây lát nhé.';
}

/** H5: webhook text thiếu message.mid khi bật rate limit. */
export function buildChatMissingMidMessage(): string {
  return (
    'Mình chưa nhận diện được tin nhắn này. ' +
    'Bạn thử gửi lại một tin ngắn giúp mình nhé.'
  );
}

/** L1: sticker / ảnh / file — bot chỉ xử lý tin chữ. */
export function buildUnsupportedMessageTypeReply(): string {
  return buildSharedUnsupportedMessageTypeReply();
}

/** Chat queue cap exceeded: oldest buffered messages were dropped. */
export function buildChatDroppedMessage(): string {
  return 'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé';
}
