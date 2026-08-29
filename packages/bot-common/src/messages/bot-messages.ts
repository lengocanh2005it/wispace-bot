export const FALLBACK_DISPLAY_NAME = 'Chào bạn nha';

/** Canonical greeting intro — also used for one-time announcements (e.g. Discord join welcome). */
export const GREETING_INTRO =
  'Mình là trợ lý WISPACE — đồng hành học IELTS Writing cùng bạn. Bạn cứ nhắn nhu cầu tự nhiên, ví dụ như xem tiến độ hay tạo bài tập mới — mình sẽ hỗ trợ bạn nhé!';

/** Greeting intros the bot rotates through so repeated hellos get variety. */
export const GREETING_VARIANTS: readonly string[] = [
  GREETING_INTRO,
  'Mình là trợ lý WISPACE — luôn sẵn sàng đồng hành cùng bạn học IELTS Writing. Cứ nhắn bất cứ điều gì, ví dụ như xem tiến độ hay tạo bài tập mới, mình sẽ lo phần còn lại!',
  'Mình là trợ lý WISPACE — hỗ trợ bạn học IELTS Writing mỗi ngày. Bạn cần gì cứ nhắn tự nhiên, mình sẽ giúp ngay nhé!',
  'Mình là trợ lý WISPACE — đồng hành cùng bạn trên hành trình IELTS Writing. Nhắn cho mình nhu cầu của bạn, ví dụ như kiểm tra tiến độ hay làm bài tập mới — mình sẽ hỗ trợ nhiệt tình!',
];

export function buildGreetingMessage(
  displayName?: string,
  random: () => number = Math.random,
): string {
  const name = displayName?.trim();
  const prefix =
    !name || name === FALLBACK_DISPLAY_NAME ? 'Chào bạn!' : `Chào ${name}!`;
  const index = Math.min(
    GREETING_VARIANTS.length - 1,
    Math.floor(random() * GREETING_VARIANTS.length),
  );
  return `${prefix} 👋 ${GREETING_VARIANTS[index] ?? GREETING_INTRO}`;
}

/** Self-intro variants the bot rotates through so repeated "bạn là ai" gets variety. */
export const SELF_INTRO_VARIANTS: readonly string[] = [
  'Mình là WISPACE Bot — trợ lý AI học IELTS Writing. Bạn cứ nhắn nhu cầu tự nhiên, mình sẽ hỗ trợ bạn nhé! 🎓',
  'Mình là WISPACE Bot — trợ lý AI đồng hành học IELTS Writing cùng bạn. Cứ nhắn bất cứ điều gì, mình sẽ giúp bạn nhé! 🎓',
  'Mình là WISPACE Bot — trợ lý AI hỗ trợ bạn luyện IELTS Writing. Nhắn cho mình nhu cầu của bạn, mình sẽ hỗ trợ tận tình nhé! 🎓',
  'Mình là WISPACE Bot — trợ lý AI chuyên đồng hành học IELTS Writing. Bạn cứ nhắn tự nhiên, mình sẽ lo phần còn lại nhé! 🎓',
];

export function buildSelfIntroMessage(
  random: () => number = Math.random,
): string {
  const index = Math.min(
    SELF_INTRO_VARIANTS.length - 1,
    Math.floor(random() * SELF_INTRO_VARIANTS.length),
  );
  return SELF_INTRO_VARIANTS[index] ?? SELF_INTRO_VARIANTS[0];
}

export function buildLinkSuccessMessage(): string {
  return 'Tài khoản WISPACE của bạn đã liên kết thành công! 🎉';
}

/** Post-link consent explainer (#596) — sent once per platform after linking. */
export function buildConsentExplainerMessage(): string {
  return (
    'Mình có thể hỗ trợ bạn 2 việc tự động nhé:\n' +
    '📈 Báo cáo tiến độ học mỗi ngày\n' +
    '⏰ Nhắc lịch học sắp tới\n\n' +
    'Bật/tắt bất cứ lúc nào bằng tin nhắn: "bật báo cáo", "tắt báo cáo", "bật nhắc học", "tắt nhắc học".'
  );
}

export function buildConsentChangedMessage(
  feature: 'report' | 'reminder',
  enabled: boolean,
): string {
  const label = feature === 'report' ? 'báo cáo tiến độ' : 'nhắc lịch học';
  return enabled
    ? `Đã BẬT ${label} cho bạn nhé ✅`
    : `Đã TẮT ${label} cho bạn nhé. Bạn bật lại bất cứ lúc nào bằng tin nhắn nhé.`;
}

/** One-time opt-out footer appended to grandfathered learners' next report (#596). */
export function buildReportOptOutFooter(): string {
  return '\n\n—\nBạn không muốn nhận báo cáo tự động? Nhắn "tắt báo cáo" để tắt nhé.';
}

/** Shared bounded response for unsupported/non-text user messages. */
export function buildUnsupportedMessageTypeReply(): string {
  return 'Mình chỉ đọc được tin nhắn chữ/văn bản thôi nhé. Bạn gửi lại câu hỏi bằng chữ để mình hỗ trợ bạn.';
}
