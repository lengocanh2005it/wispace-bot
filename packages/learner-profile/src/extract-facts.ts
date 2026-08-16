import type { LearnerFacts } from './types';

/**
 * Tool names whose results may carry learner facts. Only tools on this
 * allowlist are ever read — unknown tools never write profile fields.
 */
export const LEARNER_FACTS_TOOLS = ['get_user_goals'] as const;

export type LearnerFactsToolName = (typeof LEARNER_FACTS_TOOLS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const EXAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Extracts learner facts from a server-derived tool result.
 *
 * Grounding-safe by construction: only whitelisted tools are read, only
 * whitelisted fields are copied, and every value must pass its type check —
 * anything malformed is dropped, never guessed. Returns null when the tool
 * is not a facts source or the result carries no valid facts.
 */
export function extractFactsFromToolResult(
  toolName: string,
  result: unknown,
  now: Date = new Date(),
): LearnerFacts | null {
  if (toolName !== 'get_user_goals' || !isRecord(result)) {
    return null;
  }

  const facts: LearnerFacts = {};
  const { targetScore, examDate } = result;

  if (
    typeof targetScore === 'number' &&
    Number.isFinite(targetScore) &&
    targetScore > 0
  ) {
    facts.targetScore = targetScore;
    facts.targetScoreFetchedAt = now;
  }

  if (typeof examDate === 'string' && EXAM_DATE_RE.test(examDate)) {
    facts.examDate = examDate;
    facts.examDateFetchedAt = now;
  }

  return Object.keys(facts).length > 0 ? facts : null;
}
