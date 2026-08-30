import { isAbortError, readHttpsUrl } from '@wispace/bot-common/utils';
import { maskExternalId } from '@wispace/bot-common/masking';
import {
  buildPrecreateExerciseUnavailableMessage,
  detectPromptInjection,
  sanitizeUntrustedTextForLlm,
} from '@wispace/llm-agent';
import type {
  ExerciseCapabilityPort,
  WispaceExercisePrecreateResult,
} from './wispace-capability.ports';
import { buildExerciseUrlFact } from './pinned-facts';
import type { PlatformAgentToolContext } from './platform-agent.types';

type PrecreateExerciseLogger = { warn(message: string): void };

export function normalizePrecreateExerciseResult(
  ctx: PlatformAgentToolContext,
  result: WispaceExercisePrecreateResult,
): Record<string, unknown> {
  const messageHint =
    typeof result.message === 'string' && result.message.trim()
      ? sanitizeUntrustedTextForLlm(result.message, { maxChars: 500 }).text
      : undefined;

  if (result.status === 'created' || result.status === 'already_exists') {
    const exerciseUrl = readHttpsUrl(result.exerciseUrl);
    ctx.pinnedFacts = [
      ...(ctx.pinnedFacts ?? []),
      buildExerciseUrlFact(exerciseUrl),
    ];
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
    messageHint: buildPrecreateExerciseUnavailableMessage(),
  };
}

export function intentUnclearPrecreateExerciseResult(): {
  status: 'intent_unclear';
  messageHint: string;
} {
  return {
    status: 'intent_unclear',
    messageHint:
      'Bạn xác nhận muốn tạo bài tập mới nhé — mình sẽ tạo bài tập tiếp theo trong roadmap cho bạn.',
  };
}

/**
 * Strong request phrases that count as explicit intent to create the next
 * roadmap exercise — anything else is NOT an authorization boundary (#163).
 */
const PRECREATE_INTENT_RE =
  /(?:tạo|cho|nhận|đưa|giao)\s+(?:(?:mình|em|tôi|anh|chị|bạn)\s+)?(?:một\s+)?bài(?:\s+tập)?(?:\s+(?:mới|tiếp\s+theo))?/i;

/** Selection words — the tool does not support them, so no create either. */
const PRECREATE_SELECTION_RE =
  /task\s*1|task\s*2|taskType|exerciseTopic|topic|difficulty/i;

export type PrecreateIntentCheck = { ok: true } | { ok: false; reason: string };

/**
 * Application-level explicit-intent gate (#163): the WISPACE create endpoint
 * is only called when the learner's own message clearly requests a new
 * exercise. Prompt instructions alone are not an authorization boundary —
 * a model misclassification, indirect injection or ambiguous message cannot
 * execute the side effect.
 */
export function checkPrecreateIntent(
  userText: string | undefined,
): PrecreateIntentCheck {
  const text = userText?.trim();
  if (!text) {
    return { ok: false, reason: 'missing_user_text' };
  }
  if (detectPromptInjection(text).isInjection) {
    return { ok: false, reason: 'injection' };
  }
  if (PRECREATE_SELECTION_RE.test(text)) {
    return { ok: false, reason: 'selection_requested' };
  }
  if (!PRECREATE_INTENT_RE.test(text)) {
    return { ok: false, reason: 'no_explicit_intent' };
  }
  return { ok: true };
}

export async function executePrecreateExerciseTool(
  ctx: PlatformAgentToolContext,
  exercisePort: ExerciseCapabilityPort | undefined,
  options: {
    getNotLinkedMessage: () => string;
    logger?: PrecreateExerciseLogger;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  if (!ctx.userId) {
    return { available: false, message: options.getNotLinkedMessage() };
  }

  // Intent gate: never call the create endpoint without explicit learner
  // intent in the current message (#163).
  const intent = checkPrecreateIntent(ctx.userText);
  if (!intent.ok) {
    logUnavailable(
      options.logger,
      ctx.externalUserId,
      `intent_unclear: ${intent.reason}`,
    );
    return intentUnclearPrecreateExerciseResult();
  }

  ctx.privateDataFetched = true;

  if (!exercisePort) {
    logUnavailable(options.logger, ctx.externalUserId, 'missing_client');
    return unavailablePrecreateExerciseResult();
  }

  try {
    const result = await exercisePort.precreateNextExercise(
      ctx.externalUserId,
      { signal },
    );
    return normalizePrecreateExerciseResult(ctx, result);
  } catch (error) {
    logUnavailable(
      options.logger,
      ctx.externalUserId,
      isAbortError(error) ? 'timeout' : 'request_failed',
    );
    return unavailablePrecreateExerciseResult();
  }
}

function logUnavailable(
  logger: PrecreateExerciseLogger | undefined,
  externalUserId: string,
  reason: string,
): void {
  logger?.warn(
    `Tool precreate_next_exercise unavailable for externalUserId=${maskExternalId(
      externalUserId,
    )}: ${reason}`,
  );
}
