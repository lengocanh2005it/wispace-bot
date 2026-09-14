import {
  isGreetingOnly,
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '@wispace/llm-agent';
import { isMessenger24hWindowError } from '../contracts/messenger-delivery.contract';
import { buildUnsupportedMessageTypeReply as buildSharedUnsupportedMessageTypeReply } from '@wispace/bot-common/messages';
export {
  MessengerApiError,
  isMessenger24hWindowError,
  isMessengerSenderActionError,
} from '../contracts/messenger-delivery.contract';

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
