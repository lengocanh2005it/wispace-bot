import { sanitizeUntrustedTextForLlm } from '@wispace/llm-agent';
import type { PrecreateExerciseResult } from '@wispace/wispace-client';
import type { PlatformAgentToolContext } from './platform-agent.types';

export function normalizePrecreateExerciseResult(
  ctx: PlatformAgentToolContext,
  result: PrecreateExerciseResult,
): Record<string, unknown> {
  const messageHint =
    typeof result.message === 'string' && result.message.trim()
      ? sanitizeUntrustedTextForLlm(result.message, { maxChars: 500 }).text
      : undefined;

  if (result.status === 'created' || result.status === 'already_exists') {
    const exerciseUrl = readHttpsUrl(result.exerciseUrl);
    ctx.precreatedExerciseUrl = exerciseUrl;
    return {
      status: result.status,
      exerciseUrl,
      ...(messageHint ? { messageHint } : {}),
    };
  }

  return {
    status: result.status,
    ...(messageHint ? { messageHint } : {}),
  };
}

export function unavailablePrecreateExerciseResult(): {
  status: 'unavailable';
  messageHint: string;
} {
  return {
    status: 'unavailable',
    messageHint: 'Hiện chưa thể tạo bài tập mới. Bạn thử lại sau ít phút nhé.',
  };
}

function readHttpsUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid exercise URL');

  const url = value.trim();
  try {
    if (new URL(url).protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('invalid exercise URL');
  }

  return url;
}
