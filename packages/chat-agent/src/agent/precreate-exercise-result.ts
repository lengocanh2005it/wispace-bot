import { isAbortError, maskExternalId } from '@wispace/bot-common';
import {
  buildPrecreateExerciseUnavailableMessage,
  sanitizeUntrustedTextForLlm,
} from '@wispace/llm-agent';
import {
  readHttpsUrl,
  type PrecreateExerciseResult,
  type WispaceExerciseService,
} from '@wispace/wispace-client';
import type { PlatformAgentToolContext } from './platform-agent.types';

type PrecreateExerciseService = Pick<
  WispaceExerciseService,
  'precreateNextExercise'
>;

type PrecreateExerciseLogger = { warn(message: string): void };

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
    messageHint: buildPrecreateExerciseUnavailableMessage(),
  };
}

export async function executePrecreateExerciseTool(
  ctx: PlatformAgentToolContext,
  exerciseService: PrecreateExerciseService | undefined,
  options: {
    getNotLinkedMessage: () => string;
    logger?: PrecreateExerciseLogger;
  },
  signal?: AbortSignal,
): Promise<unknown> {
  if (!ctx.userId) {
    return { available: false, message: options.getNotLinkedMessage() };
  }

  ctx.privateDataFetched = true;

  if (!exerciseService) {
    logUnavailable(options.logger, ctx.externalUserId, 'missing_client');
    return unavailablePrecreateExerciseResult();
  }

  try {
    const result = await exerciseService.precreateNextExercise(
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
