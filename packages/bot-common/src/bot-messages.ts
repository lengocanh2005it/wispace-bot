export const FALLBACK_DISPLAY_NAME = 'Chào bạn nha';

export const GREETING_INTRO =
  'Mình là trợ lý WISPACE — đồng hành học IELTS Writing cùng bạn. Bạn cứ nhắn nhu cầu tự nhiên, ví dụ như xem tiến độ hay tạo bài tập mới — mình sẽ hỗ trợ bạn nhé!';

export function buildGreetingMessage(displayName?: string): string {
  const name = displayName?.trim();
  if (!name || name === FALLBACK_DISPLAY_NAME) {
    return `Chào bạn! 👋 ${GREETING_INTRO}`;
  }
  return `Chào ${name}! 👋 ${GREETING_INTRO}`;
}

export function buildSelfIntroMessage(): string {
  return 'Mình là WISPACE Bot — trợ lý AI học IELTS Writing. Bạn cứ nhắn nhu cầu tự nhiên, mình sẽ hỗ trợ bạn nhé! 🎓';
}

export function buildLinkSuccessMessage(): string {
  return 'Tài khoản WISPACE của bạn đã liên kết thành công! 🎉';
}
