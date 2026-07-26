const IN_SCOPE_HINTS =
  /wispace|ielts|writing|task\s*1|task\s*2|lịch\s*học|buổi\s*học|tiến\s*độ|báo\s*cáo|band|mục\s*tiêu|ngày\s*thi|đổi\s*lịch|dời\s*lịch|nhắc\s*lịch|đăng\s*ký|học\s*viên|luyện\s*đề|essay|graph|chart|process/i;

const OFF_TOPIC_PATTERNS = [
  /thời\s*tiết|weather|mưa\s*hôm nay/i,
  /bóng\s*đá|world\s*cup|phim\s+|game\s+|netflix/i,
  /bitcoin|crypto|chứng\s*khoán|forex/i,
  /nấu\s*ăn|công\s*thức\s*nấu|recipe/i,
  /chính\s*trị|bầu\s*cử|tổng\s*thống/i,
  /python|javascript|java\s+code|lập\s*trình\s+web/i,
  /toán\s+lớp|vật\s+lý|hóa\s+học(?!\s*ielts)/i,
  /bác\s*sĩ|khám\s*bệnh|thuốc|điều\s*trị|y\s*khoa|pháp\s*luật|luật\s*sư|tư\s*vấn\s*pháp\s*luật|tâm\s*lý|tư\s*vấn\s*tâm\s*lý/i,
] as const;

const GREETING_ONLY =
  /^(?:hello|hi|hey|chào|xin\s*chào|alo)(?:\s+(?:bạn|bot|ơi|nhé|nha|ạ|shop))*[\s!.,?]*$|^(?:ok|oke|okay|ừ|vâng|dạ|cảm\s*ơn|thanks|thank\s*you)[\s!.?]*$/i;

/**
 * Short messages (<=20 chars) that don't match any scope hint or off-topic pattern
 * are allowed through — they're likely short Vietnamese responses or acknowledgments
 * that the LLM can handle safely.
 */
const SHORT_AMBIGUOUS_THRESHOLD = 20;

/** WISPACE domain scope check — shared across all bot platforms. */
export function isObviouslyOffTopic(userText: string): boolean {
  const text = userText.trim();
  if (!text || GREETING_ONLY.test(text)) {
    return false;
  }

  if (IN_SCOPE_HINTS.test(text)) {
    return false;
  }

  // Allow short ambiguous messages through (e.g. "ok", "vâng ạ", "cảm ơn")
  if (text.length <= SHORT_AMBIGUOUS_THRESHOLD) {
    return false;
  }

  return OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the message is only a greeting/ack — safe to answer with a canned reply when the LLM is unavailable. */
export function isGreetingOnly(userText: string): boolean {
  return GREETING_ONLY.test(userText.trim());
}
