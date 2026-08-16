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
const TIME_MARKER =
  '\\b\\d{1,2}[/-]\\d{1,2}([/-]\\d{2,4})?\\b|\\b\\d{1,2}:\\d{2}\\b';
const TIME_MARKER_GLOBAL_RE = new RegExp(TIME_MARKER, 'gi');
// Per-marker claim windows (mirror the original context distances):
// schedule context within 60 chars before or 40 chars after the marker.
const SCHEDULE_CLAIM_BEFORE_RE = new RegExp(
  `${SCHEDULE_CONTEXT}[^.!?\\n]{0,60}$`,
  'i',
);
const SCHEDULE_CLAIM_AFTER_RE = new RegExp(
  `^[^.!?\\n]{0,40}${SCHEDULE_CONTEXT}`,
  'i',
);

// ─── Additional personal-data claim families (#164) ───────────────────────
// Centralized inventory: each claim family maps a claim-shaped response
// fragment to the tools that legitimately ground it.

// Band TARGET (whole or decimal) — "mục tiêu band của bạn là 7".
const TARGET_BAND_RE = new RegExp(
  `(mục tiêu band|band mục tiêu|target band)[^.!?\\n]{0,30}\\d+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?[^.!?\\n]{0,30}(mục tiêu band|band mục tiêu)`,
  'i',
);

// Exam date — "ngày thi của bạn là 20/11/2026".
const EXAM_DATE_RE = new RegExp(
  `(ngày thi|dự thi|thi vào)[^.!?\\n]{0,20}\\d{1,2}[/-]\\d{1,2}([/-]\\d{2,4})?`,
  'i',
);

// Task counts / status — "bạn đã làm 15 bài Task 1", "đã hoàn thành 8/12 bài".
const TASK_COUNT_RE = new RegExp(
  `(đã (?:làm|viết|nộp|hoàn thành|sửa|chữa)|số bài|bài đã làm)[^.!?\\n]{0,25}\\d{1,2}\\s*(?:bài|task\\s*1|task\\s*2)|\\d{1,2}\\s*/\\s*\\d{1,2}\\s*bài`,
  'i',
);

// Roadmap / exercise state — the precreate status phrases.
const ROADMAP_STATE_RE = new RegExp(
  `(chưa có roadmap|đã hoàn thành toàn bộ bài tập|bài tập đã tồn tại|đã tạo bài tập mới|bài tập mới đã sẵn sàng|đã tạo bài mới)`,
  'i',
);

const GOALS_TOOLS: ReadonlySet<string> = new Set([
  'get_user_goals',
  'get_learning_progress_report',
]);

const PROGRESS_TOOLS: ReadonlySet<string> = new Set([
  'get_learning_progress_report',
]);

const EXERCISE_TOOLS: ReadonlySet<string> = new Set([
  'precreate_next_exercise',
]);

/**
 * Checks whether the LLM response contains specific personal data claims
 * (band scores/targets, exam dates, schedule dates/times, task counts,
 * roadmap state) without a corresponding tool having been called in this
 * turn. Returns suspicious=true if grounding is missing.
 *
 * Echo suppression is claim-scoped (#157): a time marker the user supplied
 * in their own message suppresses ONLY the schedule claim carrying that
 * marker (re-statement) — unrelated score/schedule claims in the same
 * response are still checked.
 */
export function checkLlmGrounding(
  responseText: string,
  toolsCalledThisTurn: ReadonlySet<string>,
  userText?: string,
): LlmGroundingResult {
  if (
    PERSONAL_SCORE_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, SCORE_TOOLS)
  ) {
    return { suspicious: true, reason: 'score_without_tool' };
  }

  if (
    TARGET_BAND_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, GOALS_TOOLS)
  ) {
    return { suspicious: true, reason: 'score_without_tool' };
  }

  if (
    EXAM_DATE_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, GOALS_TOOLS)
  ) {
    return { suspicious: true, reason: 'score_without_tool' };
  }

  if (
    TASK_COUNT_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, PROGRESS_TOOLS)
  ) {
    return { suspicious: true, reason: 'score_without_tool' };
  }

  if (
    ROADMAP_STATE_RE.test(responseText) &&
    !hasAny(toolsCalledThisTurn, EXERCISE_TOOLS)
  ) {
    return { suspicious: true, reason: 'schedule_without_tool' };
  }

  if (
    !hasAny(toolsCalledThisTurn, SCHEDULE_TOOLS) &&
    hasUngroundedScheduleClaim(responseText, userText)
  ) {
    return { suspicious: true, reason: 'schedule_without_tool' };
  }

  return { suspicious: false };
}

/**
 * Per-marker schedule grounding: walks every time marker in the response;
 * a marker echoed from the user's own message is a safe re-statement, any
 * OTHER marker sitting inside a schedule claim (context word nearby) is
 * ungrounded.
 */
function hasUngroundedScheduleClaim(
  responseText: string,
  userText: string | undefined,
): boolean {
  for (const match of responseText.matchAll(TIME_MARKER_GLOBAL_RE)) {
    const marker = match[0];
    if (userText?.toLowerCase().includes(marker.toLowerCase())) {
      continue;
    }
    const index = match.index ?? 0;
    const before = responseText.slice(Math.max(0, index - 60), index);
    const after = responseText.slice(
      index + marker.length,
      index + marker.length + 40,
    );
    if (
      SCHEDULE_CLAIM_BEFORE_RE.test(before) ||
      SCHEDULE_CLAIM_AFTER_RE.test(after)
    ) {
      return true;
    }
  }
  return false;
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
