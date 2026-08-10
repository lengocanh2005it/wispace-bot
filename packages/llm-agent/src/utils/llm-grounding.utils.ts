import { SCORE_TOOLS, SCHEDULE_TOOLS } from '../agent.tools';

export interface LlmGroundingResult {
  suspicious: boolean;
  reason?: 'score_without_tool' | 'schedule_without_tool';
}

// Personal score claims require a score keyword ("điểm/band/score/ielts")
// near a decimal — generic advice like "bạn có thể đạt 6.5 nếu luyện Task 1"
// no longer trips the check.
const SCORE_CONTEXT = '(điểm|band|score|ielts|thang\\s*điểm)';
const DECIMAL_SCORE = '\\d+[.,]\\d+';
const PERSONAL_SCORE_RE = new RegExp(
  `${SCORE_CONTEXT}[^.!?\\n]{0,60}${DECIMAL_SCORE}|${DECIMAL_SCORE}[^.!?\\n]{0,40}${SCORE_CONTEXT}`,
  'i',
);

// Personal schedule claims require a schedule context word ("buổi học/lịch
// học/học vào/đã dời/...") near a date or clock time — a bare "lúc 19:30" or
// "ngày 2/9" mention is not enough.
const SCHEDULE_CONTEXT =
  '(buổi học|lịch học|học vào|đã dời|được dời|chuyển lịch|ca học|giờ học)';
const TIME_MARKER = '\\b\\d{1,2}[/-]\\d{1,2}([/-]\\d{2,4})?\\b|\\b\\d{1,2}:\\d{2}\\b';
const PERSONAL_SCHEDULE_RE = new RegExp(
  `${SCHEDULE_CONTEXT}[^.!?\\n]{0,60}(?:${TIME_MARKER})|(?:${TIME_MARKER})[^.!?\\n]{0,60}${SCHEDULE_CONTEXT}`,
  'i',
);
const TIME_MARKER_RE = new RegExp(TIME_MARKER, 'i');

/**
 * Checks whether the LLM response contains specific personal data claims
 * (band scores, session dates/times) without a corresponding tool having
 * been called in this turn. Returns suspicious=true if grounding is missing.
 *
 * `userText` (the user's own message) suppresses the check when the flagged
 * date/time is echoed from what the user just said — e.g. "buổi học 15/08
 * đã được dời" answering a user who typed "15/08" — that is re-statement,
 * not an ungrounded claim.
 */
export function checkLlmGrounding(
  responseText: string,
  toolsCalledThisTurn: ReadonlySet<string>,
  userText?: string,
): LlmGroundingResult {
  if (echoesUserData(responseText, userText)) {
    return { suspicious: false };
  }

  if (
    PERSONAL_SCORE_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, SCORE_TOOLS)
  ) {
    return { suspicious: true, reason: 'score_without_tool' };
  }

  if (
    PERSONAL_SCHEDULE_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, SCHEDULE_TOOLS)
  ) {
    return { suspicious: true, reason: 'schedule_without_tool' };
  }

  return { suspicious: false };
}

function echoesUserData(
  responseText: string,
  userText: string | undefined,
): boolean {
  if (!userText) {
    return false;
  }

  // match() returns capturing groups after [0]; only the full match matters.
  const marker = responseText.match(TIME_MARKER_RE)?.[0];
  if (!marker) {
    return false;
  }

  return userText.toLowerCase().includes(marker.toLowerCase());
}

function hasAny(
  called: ReadonlySet<string>,
  required: ReadonlySet<string>,
): boolean {
  for (const tool of required) {
    if (called.has(tool)) return true;
  }
  return false;
}
