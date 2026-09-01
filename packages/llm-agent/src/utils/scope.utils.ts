export function normalizeScopeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/đ/gi, 'd')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const IN_SCOPE_HINTS =
  /wispace|ielts|writing|task\s*1|task\s*2|lich\s*hoc|buoi\s*hoc|tien\s*do|bao\s*cao|band|muc\s*tieu|ngay\s*thi|doi\s*lich|nhac\s*lich|dang\s*ky|hoc\s*vien|luyen\s*de|essay|graph|chart|process/i;

const OFF_TOPIC_PATTERNS = [
  /thoi\s*tiet|weather|mua\s*hom nay/i,
  /bong\s*da|world\s*cup|phim\s+|game\s+|netflix/i,
  /bitcoin|crypto|chung\s*khoan|forex/i,
  /nau\s*an|cong\s*thuc\s*nau|recipe/i,
  /chinh\s*tri|bau\s*cu|tong\s*thong/i,
  /python|javascript|java\s+code|lap\s*trinh\s+web/i,
  /toan\s+lop|vat\s*ly|hoa\s*hoc(?!\s*ielts)/i,
  /bac\s*si|kham\s*benh|thuoc|dieu\s*tri|y\s*khoa|phap\s*luat|luat\s*su|tu\s*van\s*phap\s*luat|tam\s*ly|tu\s*van\s*tam\s*ly/i,
] as const;

/**
 * Study-related stress / discouragement (#598): these messages deserve the
 * empathy-first prompt branch, so they must reach the LLM instead of the
 * pre-LLM canned replies. Tight hand-rolled list — a false positive only
 * means a warmer reply; keep crisis/self-harm vocabulary OUT (explicit
 * non-goal of #598).
 */
const DISTRESS_PATTERNS = [
  /ap\s*luc/,
  /chan\s*(qua|roai|roi|lam)/,
  /bo\s*cuoc/,
  /met\s*(moi|qua|roi|lam)/,
  /\bnan\b|nan\s*(qua|roai|roi|lam)/,
  /that\s*vong/,
  /hoc\s*mai\s*(ma)?\s*khong/,
  /khong\s*(the\s*)?(hoc|noi)\s*noi/,
  /stress(ed)?/,
  /burn(t|ing)?\s*out/,
] as const;

/** True when the message expresses study stress / discouragement (#598). */
export function isDistressExpression(userText: string): boolean {
  const normalized = normalizeScopeText(userText.trim());
  if (!normalized) return false;
  return matchesDistress(normalized);
}

/** Rescue shared by both pre-LLM gates — normalization is idempotent. */
function matchesDistress(normalized: string): boolean {
  return DISTRESS_PATTERNS.some((pattern) => pattern.test(normalized));
}

const GREETING_ONLY =
  /^(?:hello|hi|hey|chao|xin\s*chao|alo)(?:\s+(?:ban|bot|oi|nhe|nha|a|shop))*[\s!.,?]*$|^(?:ok|oke|okay|u|vang|da|cam\s*on|thanks|thank\s*you)[\s!.?]*$/i;

const SHORT_FRAGMENT_THRESHOLD = 4;

/** WISPACE domain scope check — shared across all bot platforms. */
export function isObviouslyOffTopic(userText: string): boolean {
  const text = userText.trim();
  const normalized = normalizeScopeText(text);
  if (!text || GREETING_ONLY.test(normalized)) {
    return false;
  }

  // A distressed learner must reach the empathy-first prompt branch (#598),
  // even when the message mentions off-topic vocab (e.g. "đi khám tâm lý").
  if (matchesDistress(normalized)) {
    return false;
  }

  if (IN_SCOPE_HINTS.test(normalized)) {
    return false;
  }

  // Known irrelevant phrases are blocked even when short; this keeps
  // repeated off-topic follow-ups out of the LLM path (#401).
  return OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** True when the message is only a greeting/ack — safe to answer with a canned reply when the LLM is unavailable. */
export function isGreetingOnly(userText: string): boolean {
  return GREETING_ONLY.test(normalizeScopeText(userText.trim()));
}

const AMBIGUOUS_FRAGMENTS =
  /^(?:thu|bai|cai\s+do|hoc\s+gi+|hco|lch|lichh|cho\s+xin|gi\s*vay|sao\s*the|thi\s*sao|hom\s+nay|ngay\s+mai|mai|tuan\s+(?:nay|sau)|sang|chieu|toi)$/i;

/** Short acknowledgment patterns — safe for LLM, not ambiguous. */
const SHORT_ACK =
  /^(?:ok|oke|okay|u|vang|da|a|o|ha|nhe|di|ok\s+nhe|ok\s+nha)$/i;

/**
 * True when the message is too vague to identify intent safely.
 * Ambiguous messages get a clarification reply instead of tool execution.
 */
export function isAmbiguousMessage(userText: string): boolean {
  const rawText = userText.trim();
  const text = normalizeScopeText(rawText);
  if (!text) return true;
  // A distressed learner reaches the empathy-first branch (#598), never the
  // clarification menu — short cries like "áp lực thi quá" must reach the LLM.
  if (matchesDistress(text)) {
    return false;
  }
  // Random/accidental: non-alphanumeric chars dominate (>=50% of length)
  const nonAlpha = rawText.replace(/[\p{L}\p{N}]/gu, '');
  if (nonAlpha.length >= rawText.length / 2 && rawText.length <= 20)
    return true;
  if (
    rawText.length <= SHORT_FRAGMENT_THRESHOLD &&
    !SHORT_ACK.test(text) &&
    !GREETING_ONLY.test(text)
  ) {
    return true;
  }
  if (AMBIGUOUS_FRAGMENTS.test(text)) return true;
  return false;
}
