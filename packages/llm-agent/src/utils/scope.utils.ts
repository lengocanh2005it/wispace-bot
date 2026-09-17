import { buildSafetyScanCandidates } from './prompt-injection.utils';

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

const TOKEN_REGEX = /[\p{L}\p{N}]+/gu;

/** Default greeting vocabulary shared by the fast-path detector and scope gate. */
export const DEFAULT_GREETING_KEYWORDS = [
  'hi',
  'hello',
  'hey',
  'chào',
  'xin chào',
  'good morning',
  'good afternoon',
  'good evening',
  'chào buổi sáng',
  'chào buổi tối',
  'sup',
  'yo',
  'alo',
] as const;

const GREETING_SUFFIXES = new Set([
  'ban',
  'bot',
  'oi',
  'nhe',
  'nha',
  'a',
  'shop',
]);

function tokenize(text: string): string[] {
  return text.match(TOKEN_REGEX)?.map((token) => token.toLowerCase()) ?? [];
}

function sameTokens(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

/**
 * Match a keyword only when it is the complete message, optionally followed
 * by the small set of established greeting suffixes.
 */
export function matchStandaloneKeyword(
  userText: string,
  keywords: readonly string[],
  options: { allowGreetingSuffix?: boolean } = {},
): string | undefined {
  const inputCandidates = buildSafetyScanCandidates(userText)
    .map(tokenize)
    .filter((tokens) => tokens.length > 0);

  return keywords.find((keyword) => {
    const keywordCandidates = buildSafetyScanCandidates(keyword)
      .map(tokenize)
      .filter((tokens) => tokens.length > 0);

    return inputCandidates.some((inputTokens) =>
      keywordCandidates.some((keywordTokens) => {
        if (sameTokens(inputTokens, keywordTokens)) return true;
        if (
          !options.allowGreetingSuffix ||
          inputTokens.length <= keywordTokens.length ||
          !keywordTokens.every((token, index) => inputTokens[index] === token)
        ) {
          return false;
        }
        return inputTokens
          .slice(keywordTokens.length)
          .every((token) => GREETING_SUFFIXES.has(token));
      }),
    );
  });
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
  // Keep medical/safety wording in the shared prompt path for crisis handoff.
  /phap\s*luat|luat\s*su|tu\s*van\s*phap\s*luat/i,
] as const;

/**
 * Study-related stress / discouragement (#598): these messages deserve the
 * empathy-first prompt branch, so they must reach the LLM instead of the
 * pre-LLM canned replies. Tight hand-rolled list — a false positive only
 * means a warmer reply; crisis handling remains a separate prompt posture.
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

const ACK_ONLY = new Set([
  'ok',
  'oke',
  'okay',
  'u',
  'vang',
  'da',
  'cam on',
  'thanks',
  'thank you',
]);

const SHORT_FRAGMENT_THRESHOLD = 4;

/** WISPACE domain scope check — shared across all bot platforms. */
export function isObviouslyOffTopic(userText: string): boolean {
  const text = userText.trim();
  const normalized = normalizeScopeText(text);
  if (!text || isGreetingOnly(text)) {
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
  const normalized = normalizeScopeText(userText.trim());
  return (
    matchStandaloneKeyword(userText, DEFAULT_GREETING_KEYWORDS, {
      allowGreetingSuffix: true,
    }) !== undefined || ACK_ONLY.has(normalized)
  );
}

const AMBIGUOUS_FRAGMENTS =
  /^(?:thu|bai|cai\s+do|hoc\s+gi+|hco|lch|lichh|cho\s+xin|gi\s*vay|sao\s*the|thi\s*sao|hom\s+nay|ngay\s+mai|mai|tuan\s+(?:nay|sau)|sang|chieu|toi)$/i;

/** Short acknowledgment patterns — safe for LLM, not ambiguous. */
const SHORT_ACK =
  /^(?:ok|oke|okay|u|vang|da|a|o|ha|nhe|di|ok\s+nhe|ok\s+nha)$/i;

/**
 * Stop/resume intent vocabulary (#959). A learner typing `dừng` / `thôi` /
 * `stop` stated an intent clearly — answering with the clarification menu
 * would be dishonest, and `tiếp` is the resume half of the same interaction.
 * Normalized (no-diacritic) exact match; polite trailing punctuation is
 * already stripped by `normalizeScopeText`.
 */
const STOP_INTENT =
  /^(?:dung|dung lai|stop|thoi|thoi khoi|thoi di|huy|huy di|huy bo|khoan|khoan da|khong can|khong can nua|bo qua|nevermind|never mind)$/i;
const RESUME_INTENT = /^(?:tiep|tiep tuc|continue|go on)$/i;
/**
 * Short but meaningful scores/band references — `7.0`, `6.5?`, `band`.
 * Checked against the raw text: `normalizeScopeText` would turn `7.0` into
 * two bare numbers and lose the decimal.
 */
const SHORT_MEANINGFUL =
  /^(?:band(?:\s+\d+(?:[.,]\d+)?)?|\d+(?:[.,]\d+)?)[\s?!.]*$/i;

/** True when the message is a stop request (#959) — gets an honest reply, not a menu. */
export function isStopIntent(userText: string): boolean {
  const text = normalizeScopeText(userText.trim());
  return text.length > 0 && STOP_INTENT.test(text);
}

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
  // #959: a score/band reference like `6.5?` is meaningful — the
  // punctuation-share check below must not eat it.
  if (SHORT_MEANINGFUL.test(rawText)) {
    return false;
  }
  // Random/accidental: non-alphanumeric chars dominate (>=50% of length)
  const nonAlpha = rawText.replace(/[\p{L}\p{N}]/gu, '');
  if (nonAlpha.length >= rawText.length / 2 && rawText.length <= 20)
    return true;
  if (
    rawText.length <= SHORT_FRAGMENT_THRESHOLD &&
    !SHORT_ACK.test(text) &&
    !isGreetingOnly(rawText) &&
    // #959: known short intents are meaningful, not vague — a stop word, a
    // resume word, or a score reference must never hit the length gate.
    !STOP_INTENT.test(text) &&
    !RESUME_INTENT.test(text) &&
    !SHORT_MEANINGFUL.test(rawText)
  ) {
    return true;
  }
  if (AMBIGUOUS_FRAGMENTS.test(text)) return true;
  return false;
}
