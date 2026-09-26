import {
  getAgentToolNamesByGroundingClaim,
  SCORE_TOOLS,
  SCHEDULE_TOOLS,
  type BoundedToolDisclosure,
} from '../agent.tools';

export interface LlmGroundingResult {
  suspicious: boolean;
  reason?:
    | 'score_without_tool'
    | 'schedule_without_tool'
    | 'capped_result_claim';
  replacementText?: string;
}

// Require an explicit claim about the learner; generic band explanations
// and advice are part of IELTS Writing support, not personal-data claims.
const DECIMAL_SCORE = '\\d+[.,]\\d+';
const USER_PERSONAL_SCORE_RE = new RegExp(
  `(?:\\bmy\\s+(?:ielts\\s+)?(?:score|band)\\b[^.!?\\n]{0,25}?${DECIMAL_SCORE}|\\bi\\s+scored\\b[^.!?\\n]{0,20}?${DECIMAL_SCORE}|\\bi\\s+got\\b[^.!?\\n]{0,20}?${DECIMAL_SCORE}[^.!?\\n]{0,20}?\\b(?:in|on)\\s+ielts\\b|(?:mình|tôi|em|tớ)[^.!?\\n]{0,25}?(?:được\\s+chấm|đạt\\s+(?:band|điểm|score)|được\\s+(?:band|điểm|score)|(?:band|điểm|score))[^.!?\\n]{0,25}?${DECIMAL_SCORE}|(?:band|điểm|score)[^.!?\\n]{0,25}?của\\s+(?:mình|tôi|em|tớ)[^.!?\\n]{0,25}?${DECIMAL_SCORE})`,
  'gi',
);
const QUOTED_USER_TEXT_RE =
  /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<![\p{L}\p{N}])'[^'\r\n]*'(?![\p{L}\p{N}])/gu;
const PERSONAL_SCORE_CONTEXT =
  '(?:(?:điểm|band|score)[^.!?\\n]{0,25}của\\s+bạn|bạn\\s+(?:đang\\s+ở|đạt)\\s+(?:band|điểm|score)|your\\s+(?:current\\s+)?(?:ielts\\s+)?(?:score|band)|you\\s+(?:are\\s+at|scored))';
const PERSONAL_SCORE_RE = new RegExp(
  `(?:${PERSONAL_SCORE_CONTEXT}[^.!?\\n]{0,60}?${DECIMAL_SCORE}|${DECIMAL_SCORE}[^.!?\\n]{0,40}(?:của\\s+bạn|your\\s+(?:current\\s+)?(?:score|band)))`,
  'gi',
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

const CAPPED_LIST_CONTEXT =
  '(?:lịch(?:\\s+học)?|buổi(?:\\s+học)?|dữ\\s*liệu|kết\\s*quả|data|sessions?|entries|records|results|items|schedule|calendar|list)';
const CAPPED_ENGLISH_LIST_SUFFIX =
  '(?:(?:available|upcoming|past|previous|study|calendar)\\s+){0,2}(?:sessions?|data|entries|records|results|items)';
const CAPPED_ENGLISH_TRAILER =
  '(?:\\s+(?:(?:are|is|were|was)\\s+)?(?:available|included|returned|shown|left|remaining|remain|remains)\\b)?';
const CAPPED_NO_MORE_RE = `(?:hết\\s+(?:tất\\s+cả\\s+|các\\s+)?${CAPPED_LIST_CONTEXT}(?:\\s+rồi)?|đã\\s+hết\\s+(?:các\\s+)?${CAPPED_LIST_CONTEXT}(?:\\s+rồi)?|${CAPPED_LIST_CONTEXT}\\s+đã\\s+hết(?:\\s+rồi)?|chỉ\\s+(?:có|còn)\\s+\\d+\\s+${CAPPED_LIST_CONTEXT}|xem\\s+hết\\s+(?:danh\\s+sách|${CAPPED_LIST_CONTEXT})|không\\s+(?:còn|có)\\s+(?:các\\s+|thêm\\s+)?${CAPPED_LIST_CONTEXT}(?:\\s+(?:sắp\\s+tới|đã\\s+qua))?(?:\\s+nào)?(?:\\s+(?:nữa|khác))?|there\\s+(?:are|is|aren't|isn't)\\s+(?:no(?:\\s+any)?|any|0|zero)(?:\\s+(?:more|further|additional))?\\s+${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|no\\s+(?:more|additional|other|further)\\s+${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|no\\s+remaining\\s+${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:are|is)\\s+available|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:(?:are|were|is|was)\\s+)?found|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:is|are)\\s+(?:left|remaining|remain)|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:remain|remains|left)\\b|(?:i|you|we)\\s+(?:don't|do\\s+not|can't|cannot)\\s+(?:have|find|see)\\s+any\\s+${CAPPED_ENGLISH_LIST_SUFFIX}|you\\s+have\\s+no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX})`;
const CAPPED_VIETNAMESE_QUANTITY_RE = `(?:\\d+\\s+${CAPPED_LIST_CONTEXT}\\s+này\\s+là\\s+(?:toàn\\s*bộ|tất\\s*cả|đầy\\s*đủ))`;
const CAPPED_ENGLISH_PREDICATE_RE = `(?:(?:this|the)\\s+${CAPPED_LIST_CONTEXT}\\s+(?:is|are)\\s+(?:complete|full|entire)|(?:this|these|those)\\s+(?:is|are)\\s+(?:the\\s+)?(?:complete|full|entire)\\s+${CAPPED_LIST_CONTEXT}|(?:these|those|this)\\s+(?:are|is)\\s+the\\s+only\\s+${CAPPED_ENGLISH_LIST_SUFFIX}|only\\s+(?:\\d+\\s+)?${CAPPED_ENGLISH_LIST_SUFFIX})`;
const CAPPED_ALL_RE = `(?:${CAPPED_NO_MORE_RE}|(?:toàn\\s*bộ|tất\\s*cả|đầy\\s*đủ)(?:\\s+các)?(?:\\s+\\d+)?\\s+${CAPPED_LIST_CONTEXT}(?:\\s+(?:sắp\\s+tới|đã\\s+qua))?|${CAPPED_LIST_CONTEXT}\\s+(?:toàn\\s*bộ|tất\\s*cả|đầy\\s*đủ)|danh\\s+sách\\s+đầy\\s*đủ|${CAPPED_VIETNAMESE_QUANTITY_RE}|${CAPPED_ENGLISH_PREDICATE_RE}|all\\s+(?:(?:the|\\d+)\\s+)?${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|all\\s+of\\s+(?:the\\s+)?${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|(?:these|those|this)\\s+(?:are|is)\\s+all\\s+(?:the\\s+)?${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|every\\s+(?:\\d+\\s+)?${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|entirety\\s+of\\s+${CAPPED_ENGLISH_LIST_SUFFIX}${CAPPED_ENGLISH_TRAILER}|entire\\s+(?:schedule|list)|complete\\s+(?:schedule|list)|full\\s+(?:schedule|list))`;
const CAPPED_COMPLETENESS_RE = new RegExp(CAPPED_ALL_RE, 'giu');
const NEGATED_COMPLETENESS_RE = new RegExp(
  `(?:không\\s+phải(?:\\s+là)?|not(?:\\s+(?:the|a))?|(?:is|are|was|were)\\s+not(?:\\s+(?:the|a))?|(?:isn't|aren't|wasn't|weren't)(?:\\s+(?:the|a))?)\\s*${CAPPED_ALL_RE}\\s*$`,
  'iu',
);
const NEGATED_TRAILING_RE =
  /\s+(?:(?:are|is|were|was)\s+not|aren't|isn't|weren't|wasn't|not)\s+(?:included|returned|shown|available)\b/iu;

const UNCERTAIN_COMPLETENESS_RE =
  /(?:cannot|can't|unable\s+to)\s+(?:confirm|say|know)\s+(?:whether\s+)?(?:(?:this|that|it)\s+is\s+)?(?:the|a)?\s*$|(?:chưa\s+thể|không\s+thể)\s+xác\s+nhận\s+(?:đây\s+là)?\s*$/iu;

const GOALS_TOOLS = SCORE_TOOLS;
const PROGRESS_TOOLS = getAgentToolNamesByGroundingClaim('progress');
const EXERCISE_TOOLS = getAgentToolNamesByGroundingClaim('exercise');

/**
 * Checks whether the LLM response contains specific personal data claims
 * (band scores/targets, exam dates, schedule dates/times, task counts,
 * roadmap state) without a corresponding tool having been called in this
 * turn. Returns suspicious=true if grounding is missing.
 *
 * Echo suppression is claim-scoped: learner-supplied score/time markers
 * suppress only their matching personal claim; unrelated claims remain
 * checked.
 */
export function checkLlmGrounding(
  responseText: string,
  toolsCalledThisTurn: ReadonlySet<string>,
  userText?: string,
  boundedToolDisclosures?: ReadonlyMap<string, BoundedToolDisclosure>,
): LlmGroundingResult {
  if (
    hasUnsupportedCappedCompletenessClaim(
      responseText,
      boundedToolDisclosures,
      userText,
    )
  ) {
    return {
      suspicious: true,
      reason: 'capped_result_claim',
      replacementText: rewriteUnsupportedCappedCompletenessClaims(
        responseText,
        boundedToolDisclosures,
        userText,
      ),
    };
  }

  if (
    hasUngroundedPersonalScoreClaim(responseText, userText) &&
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

interface UnsupportedCompletenessClaim {
  start: number;
  end: number;
  text: string;
}

function claimClauseContext(
  responseText: string,
  start: number,
  end: number,
): { prefix: string; suffix: string } {
  const before = responseText.slice(0, start);
  const clauseStart =
    Math.max(
      before.lastIndexOf('.'),
      before.lastIndexOf('!'),
      before.lastIndexOf('?'),
      before.lastIndexOf(';'),
      before.lastIndexOf(','),
      before.lastIndexOf('\n'),
    ) + 1;
  const after = responseText.slice(end);
  const boundary = after.search(/[.!?;,\n]/u);
  const clauseEnd = boundary === -1 ? responseText.length : end + boundary;
  return {
    prefix: responseText.slice(clauseStart, start),
    suffix: responseText.slice(end, clauseEnd),
  };
}

function isAccurateReturnedCountClaim(
  claim: string,
  suffix: string,
  context: string,
  disclosures: ReadonlyMap<string, BoundedToolDisclosure>,
  userText?: string,
): boolean {
  const match = claim.match(
    /^only\s+(\d+)\s+(?:(?:available|upcoming|study)\s+)?sessions?$/iu,
  );
  if (!match || !/^\s+(?:(?:are|were|is|was)\s+)?returned\b/iu.test(suffix)) {
    return false;
  }
  const count = Number(match[1]);
  const scopeText = `${context} ${userText ?? ''}`;
  const mentionsPast = /(?:đã\s+qua|past|previous)/iu.test(scopeText);
  const mentionsUpcoming = /(?:sắp\s+tới|upcoming|future)/iu.test(scopeText);
  const requestsAll =
    /(?:all|everything|entire|toàn\s*bộ|tất\s*cả)/iu.test(userText ?? '') &&
    !/(?:not|n't|không(?:\s+(?:phải|là))?|chẳng|trừ)\s+(?:(?:the|a)\s+)?(?:all|everything|entire|toàn\s*bộ|tất\s*cả)/iu.test(
      userText ?? '',
    );
  const matching = [...disclosures].filter(([key, disclosure]) => {
    if (disclosure.count !== count) return false;
    const scope =
      disclosure.timeRange ??
      (key === 'get_upcoming_study_sessions' ||
      key.startsWith('get_upcoming_study_sessions:')
        ? 'upcoming'
        : undefined);
    if (mentionsPast && scope !== 'past') return false;
    if (mentionsUpcoming && scope !== 'upcoming') return false;
    if (requestsAll && scope !== 'all') return false;
    return true;
  });
  const matchingScopes = new Set(
    matching.map(
      ([key, disclosure]) =>
        disclosure.timeRange ??
        (key === 'get_upcoming_study_sessions' ||
        key.startsWith('get_upcoming_study_sessions:')
          ? 'upcoming'
          : 'unknown'),
    ),
  );
  return matchingScopes.size === 1;
}

function findUnsupportedCompletenessClaims(
  responseText: string,
  disclosures: ReadonlyMap<string, BoundedToolDisclosure>,
  userText?: string,
): UnsupportedCompletenessClaim[] {
  const claims: UnsupportedCompletenessClaim[] = [];
  for (const claim of responseText.matchAll(
    new RegExp(CAPPED_COMPLETENESS_RE.source, 'giu'),
  )) {
    const index = claim.index ?? 0;
    const { prefix, suffix } = claimClauseContext(
      responseText,
      index,
      index + claim[0].length,
    );
    const returnedSubsetClaim = isAccurateReturnedCountClaim(
      claim[0],
      suffix,
      `${prefix}${claim[0]}${suffix}`,
      disclosures,
      userText,
    );
    if (
      !returnedSubsetClaim &&
      !NEGATED_COMPLETENESS_RE.test(`${prefix}${claim[0]}`) &&
      !NEGATED_TRAILING_RE.test(`${claim[0]}${suffix}`) &&
      !UNCERTAIN_COMPLETENESS_RE.test(prefix)
    ) {
      claims.push({
        start: index,
        end: index + claim[0].length,
        text: claim[0],
      });
    }
  }
  return claims;
}

function hasUnsupportedCappedCompletenessClaim(
  responseText: string,
  boundedToolDisclosures?: ReadonlyMap<string, BoundedToolDisclosure>,
  userText?: string,
): boolean {
  return (
    boundedToolDisclosures !== undefined &&
    boundedToolDisclosures.size > 0 &&
    findUnsupportedCompletenessClaims(
      responseText,
      boundedToolDisclosures,
      userText,
    ).length > 0
  );
}

function isEnglishCompletenessClaim(claim: string): boolean {
  return /^(?:there\s+(?:are|is)|no\b|all\b|every\b|entirety\b|entire\b|complete\b|full\b|this\b|the\b|you\b|these\b|those\b|only\b)/iu.test(
    claim,
  );
}

function boundedClaimReplacement(
  claim: string,
  prefix: string,
  capitalize = false,
): string {
  const isEnglish = isEnglishCompletenessClaim(claim);
  const hasDeterminer = /\b(?:a|an|the|this|that|these|those)\s*$/iu.test(
    prefix,
  );
  const embedded = prefix.trim().length > 0 && !/[.!?]\s*$/u.test(prefix);
  const quantityMatch = claim.match(
    /^(\d+\s+.+?)\s+này\s+là\s+(?:toàn\s*bộ|tất\s*cả|đầy\s*đủ)/iu,
  );
  const noMoreClaim = new RegExp(
    `^(?:hết|${CAPPED_LIST_CONTEXT}\\s+đã\\s+hết|chỉ\\s+(?:có|còn)|không\\s+(?:còn|có)(?:\\s+các|\\s+thêm)?|xem\\s+hết|no\\s+(?:more|additional|other|further|remaining)|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:are|is)\\s+available|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}\\s+(?:(?:are|were|is|was)\\s+)?found|no\\s+${CAPPED_LIST_CONTEXT}\\s+(?:is|are)\\s+(?:left|remaining|remain)|there\\s+(?:are|is|aren't|isn't)\\s+(?:no|any|0|zero)|(?:i|you|we)\\s+(?:don't|do\\s+not|can't|cannot)\\s+(?:have|find|see)\\s+any|no\\s+(?:available\\s+|upcoming\\s+|study\\s+){0,2}(?:sessions?|data)\\s+(?:remain|left)|no\\s+${CAPPED_ENGLISH_LIST_SUFFIX}|you\\s+have\\s+no)`,
    'iu',
  ).test(claim);
  const scopeSuffix = /(?:sắp\s+tới|đã\s+qua)/iu.test(claim)
    ? ` ${/sắp\s+tới/iu.test(claim) ? 'sắp tới' : 'đã qua'}`
    : '';
  const replacement = quantityMatch
    ? `${quantityMatch[1]} này là dữ liệu đã trả về`
    : noMoreClaim
      ? isEnglish
        ? embedded
          ? 'no confirmed remaining data'
          : 'I cannot confirm whether more data remains'
        : 'chưa xác nhận còn dữ liệu nào khác'
      : isEnglish
        ? hasDeterminer
          ? 'returned data'
          : 'the returned data'
        : scopeSuffix
          ? `lịch${scopeSuffix}`
          : 'dữ liệu';
  if (!capitalize) return replacement;
  return `${replacement.charAt(0).toLocaleUpperCase()}${replacement.slice(1)}`;
}

function rewriteUnsupportedCappedCompletenessClaims(
  responseText: string,
  boundedToolDisclosures?: ReadonlyMap<string, BoundedToolDisclosure>,
  userText?: string,
): string | undefined {
  if (!boundedToolDisclosures) return undefined;
  const claims = findUnsupportedCompletenessClaims(
    responseText,
    boundedToolDisclosures,
    userText,
  );
  if (claims.length === 0) return undefined;
  let rewritten = responseText;
  for (const claim of claims.reverse()) {
    const prefix = responseText.slice(0, claim.start);
    const replacement = boundedClaimReplacement(
      claim.text,
      prefix,
      claim.start === 0 || /[.!?]\s*$/u.test(prefix),
    );
    rewritten = `${rewritten.slice(0, claim.start)}${replacement}${rewritten.slice(claim.end)}`;
  }
  return rewritten.trim();
}

function hasUngroundedPersonalScoreClaim(
  responseText: string,
  userText: string | undefined,
): boolean {
  const unquotedUserText = userText?.replace(QUOTED_USER_TEXT_RE, ' ');
  const learnerScores = new Set(
    [...(unquotedUserText?.matchAll(USER_PERSONAL_SCORE_RE) ?? [])]
      .map((match) => match[0].match(/\d+[.,]\d+/)?.[0])
      .filter((score): score is string => score !== undefined)
      .map((score) => Number(score.replace(',', '.'))),
  );
  for (const match of responseText.matchAll(PERSONAL_SCORE_RE)) {
    const scoreText = match[0].match(/\d+[.,]\d+/)?.[0];
    if (!scoreText || !learnerScores.has(Number(scoreText))) return true;
  }
  return false;
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
