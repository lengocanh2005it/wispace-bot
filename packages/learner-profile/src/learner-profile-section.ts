import type { LearnerProfile } from './types';

/** Facts older than this are considered stale and omitted from the prompt. */
export const DEFAULT_LEARNER_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

function formatTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/**
 * Builds the learner-profile section for the chat system prompt.
 *
 * Only facts fresher than `ttlMs` are listed — stale facts are dropped so
 * the model cannot reuse outdated data; the chat core already instructs it
 * to prefer fresh tool calls. Returns undefined when there is nothing fresh
 * (no profile, or every fact is stale).
 */
export function buildLearnerProfileSection(
  profile: LearnerProfile | null | undefined,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_LEARNER_PROFILE_TTL_MS,
): string | undefined {
  if (!profile) {
    return undefined;
  }

  const lines: string[] = [];
  if (
    profile.targetScore !== undefined &&
    profile.targetScoreFetchedAt !== undefined &&
    now.getTime() - profile.targetScoreFetchedAt.getTime() <= ttlMs
  ) {
    lines.push(
      `- Mục tiêu band: ${profile.targetScore} (lấy lúc ${formatTimestamp(profile.targetScoreFetchedAt)})`,
    );
  }
  if (
    profile.examDate !== undefined &&
    profile.examDateFetchedAt !== undefined &&
    now.getTime() - profile.examDateFetchedAt.getTime() <= ttlMs
  ) {
    lines.push(
      `- Ngày thi: ${profile.examDate} (lấy lúc ${formatTimestamp(profile.examDateFetchedAt)})`,
    );
  }

  if (lines.length === 0) {
    return undefined;
  }

  return [
    'Hồ sơ học viên (dữ liệu do server lấy — có thể đã cũ; khi học viên hỏi về các mục này, ưu tiên gọi lại tool trừ khi cuộc hội thoại này đã lấy dữ liệu mới hơn):',
    ...lines,
  ].join('\n');
}
