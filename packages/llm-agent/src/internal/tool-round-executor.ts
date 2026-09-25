import {
  canonicalizeToolArguments,
  getAgentToolDefinition,
  isAgentToolName,
  mergeBoundedToolDisclosures,
  parseAndValidateToolArguments,
  readBoundedToolDisclosure,
  type AgentToolName,
  type BoundedToolDisclosure,
} from '../agent.tools';
import type { AgentMetricsPort, ToolExecutorPort } from '../ports';
import {
  fitToolObservation,
  minimumToolObservationLength,
  observationMarker,
  reduceToolObservation,
  type ToolObservationOutcome,
} from '../utils/tool-observation';
import { sanitizeUntrustedTextForLlm } from '../utils/prompt-injection.utils';
import { isAbortError } from '../utils/retry.utils';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import type { LlmAgentInput } from '../types';
import { AgentLimits } from './agent-limits';

function observationMarkerWithinBudget(
  kind: 'reused' | 'truncated' | 'fallback',
  ok: boolean,
  maxChars: number,
): string {
  const marker = observationMarker(kind, ok);
  if (marker.length <= maxChars) return marker;
  const compact = JSON.stringify({ ok });
  return compact.length <= maxChars ? compact : '';
}

function fitObservationWithinBudget(
  content: string,
  maxChars: number,
  ok: boolean,
): { content: string; wasTruncated: boolean } {
  const fitted = fitToolObservation(content, maxChars);
  if (fitted.content.length <= maxChars) return fitted;
  return {
    content: observationMarkerWithinBudget('truncated', ok, maxChars),
    wasTruncated: true,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface ToolRoundLogger {
  warn(message: string): void;
}

export interface ToolRoundExecutorOptions {
  onInjection?: (reason: string, rawPreview: string, toolName: string) => void;
}

export interface ToolExecutionBudget {
  maxExecutions: number;
}

export interface ToolRoundResult {
  toolCallId: string;
  toolName: string;
  content: string;
  succeeded: boolean;
  boundedDisclosure?: BoundedToolDisclosure;
}

export interface ToolRoundExecution {
  results: ToolRoundResult[];
  /** Number of executor calls actually started (deduplicated and policy-allowed). */
  executedCount: number;
  /** One entry per successful deduplicated execution, preserving tool-name multiplicity. */
  successfulToolNames: AgentToolName[];
  boundedToolDisclosures: Map<string, BoundedToolDisclosure>;
}

/** Executes one model tool round while preserving provider message pairing. */
export class ToolRoundExecutor<TToolContext> {
  constructor(
    private readonly limits: AgentLimits,
    private readonly toolExecutor: ToolExecutorPort<TToolContext>,
    private readonly metrics: AgentMetricsPort,
    private readonly logger: ToolRoundLogger,
    private readonly options: ToolRoundExecutorOptions = {},
  ) {}

  async execute(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
    input: LlmAgentInput,
    toolContext: TToolContext,
    observationBudget: number,
    parentSignal?: AbortSignal,
    budget?: ToolExecutionBudget,
    options: ToolRoundExecutorOptions = this.options,
  ): Promise<ToolRoundExecution> {
    const uniqueByKey = new Map<
      string,
      { id: string; name: string; arguments: string }
    >();
    for (const call of toolCalls) {
      const key = this.toolCallKey(call);
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, call);
    }
    const uniqueCalls = [...uniqueByKey.values()];
    if (uniqueCalls.length !== toolCalls.length) {
      this.logger.warn(
        `LLM agent deduped ${toolCalls.length - uniqueCalls.length} duplicate tool call(s) in one round externalUserId=${maskExternalId(input.externalUserId)}`,
      );
    }

    const resultsByKey = new Map<
      string,
      {
        observation: ReturnType<typeof reduceToolObservation>;
        succeeded: boolean;
      }
    >();
    let executedInRound = 0;
    let executedCount = 0;
    const boundedToolDisclosures = new Map<string, BoundedToolDisclosure>();

    const executeCall = async (toolCall: (typeof uniqueCalls)[number]) => {
      const toolName = toolCall.name;
      const key = this.toolCallKey(toolCall);
      const argsJson = toolCall.arguments || '{}';

      if (!isAgentToolName(toolName)) {
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            error: 'Tool không được hỗ trợ',
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      const validation = parseAndValidateToolArguments(toolName, argsJson);
      if (!validation.ok) {
        this.metrics.toolPolicyDeniedInc?.(toolName, 'invalid_arguments');
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            error: validation.error,
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      if (!getAgentToolDefinition(toolName)?.capability) {
        this.metrics.toolPolicyDeniedInc?.(toolName, 'missing_capability');
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            error: 'Tool execution blocked by policy',
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }

      if (budget && executedInRound >= budget.maxExecutions) {
        this.metrics.toolPolicyDeniedInc?.(toolName, 'turn_budget_exhausted');
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            error: 'Đã đạt giới hạn tra cứu trong lượt này',
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
        return;
      }
      if (parentSignal?.aborted) {
        throw parentSignal.reason ?? new Error('Aborted');
      }
      if (budget) executedInRound += 1;
      executedCount += 1;
      const controller = new AbortController();
      const abort = () => controller.abort(parentSignal?.reason);
      parentSignal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await withTimeout(
          this.metrics.timeTool(toolName, () =>
            this.toolExecutor.execute(
              toolName,
              argsJson,
              toolContext,
              controller.signal,
            ),
          ),
          this.limits.toolExecutionTimeoutMs,
          `Tool ${toolName}`,
          () => controller.abort(),
        );
        const boundedToolDisclosure = readBoundedToolDisclosure(result);
        if (boundedToolDisclosure !== undefined) {
          boundedToolDisclosures.set(
            key,
            mergeBoundedToolDisclosures(
              boundedToolDisclosures.get(key),
              boundedToolDisclosure,
            ),
          );
        }
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            result,
            ok: true,
            maxChars: 8_000,
          }),
          succeeded: true,
        });
      } catch (error) {
        if (parentSignal?.aborted) {
          throw parentSignal.reason ?? error;
        }
        if (
          isAbortError(error) ||
          (toolName === 'reschedule_study_session' && controller.signal.aborted)
        ) {
          if (
            toolName === 'reschedule_study_session' &&
            controller.signal.aborted &&
            !isAbortError(error)
          ) {
            const abortError = new Error('Reschedule tool execution aborted');
            abortError.name = 'AbortError';
            throw abortError;
          }
          throw error;
        }
        const message = maskExternalIdInText(
          sanitizeUntrustedTextForLlm(errorMessage(error), {
            maxChars: 500,
            unsafePlaceholder: 'Tool execution failed',
          }).text,
          input.externalUserId,
        );
        this.logger.warn(
          `Tool execution failed externalUserId=${maskExternalId(input.externalUserId)} tool=${toolName} error=${message}`,
        );
        resultsByKey.set(key, {
          observation: reduceToolObservation({
            toolName,
            error: message,
            ok: false,
            maxChars: 8_000,
          }),
          succeeded: false,
        });
      } finally {
        parentSignal?.removeEventListener('abort', abort);
      }
    };

    const hasSideEffect = uniqueCalls.some(
      (call) =>
        getAgentToolDefinition(call.name)?.capability.effect !== 'read_only',
    );
    if (!hasSideEffect) {
      await Promise.all(uniqueCalls.map((call) => executeCall(call)));
    } else {
      for (const call of uniqueCalls) await executeCall(call);
    }

    const fullByKey = new Map<
      string,
      ReturnType<typeof reduceToolObservation>
    >();
    const successfulToolNames: AgentToolName[] = [];
    for (const call of uniqueCalls) {
      const result = resultsByKey.get(this.toolCallKey(call)) ?? {
        observation: this.missingObservation(call.name),
        succeeded: false,
      };
      fullByKey.set(this.toolCallKey(call), result.observation);
      if (result.succeeded && isAgentToolName(call.name)) {
        successfulToolNames.push(call.name);
      }
      const injection = result.observation.injection;
      if (injection) {
        options.onInjection?.(
          injection.reason,
          injection.rawPreview,
          call.name,
        );
      }
    }

    let remainingObservationBudget = Math.max(0, observationBudget);
    let remainingUnique = uniqueCalls.length;
    const emittedObservationKeys = new Set<string>();
    const allocatedByKey = new Map<string, string>();
    const outcomesByKey = new Map<string, ToolObservationOutcome>();
    const minimumByKey = new Map(
      uniqueCalls.map((call) => {
        const callKey = this.toolCallKey(call);
        const execution = resultsByKey.get(callKey);
        const full = fullByKey.get(callKey);
        return [
          callKey,
          full
            ? minimumToolObservationLength(
                full.content,
                execution?.succeeded ?? false,
                call.name,
              )
            : observationMarker('truncated', false).length,
        ];
      }),
    );
    const pendingUniqueKeys = new Set(minimumByKey.keys());

    for (const call of toolCalls) {
      const callKey = this.toolCallKey(call);
      const full = fullByKey.get(callKey);
      const execution = resultsByKey.get(callKey) ?? {
        observation: this.missingObservation(call.name),
        succeeded: false,
      };
      const observationKey = `${call.name}:${
        full?.wasTruncated ? `call:${callKey}` : (full?.canonical ?? callKey)
      }`;
      const resultKey = `${call.id}:${callKey}`;

      if (emittedObservationKeys.has(observationKey)) {
        const marker = observationMarkerWithinBudget(
          'reused',
          execution.succeeded,
          remainingObservationBudget,
        );
        allocatedByKey.set(resultKey, marker);
        outcomesByKey.set(resultKey, 'deduped');
        remainingObservationBudget = Math.max(
          0,
          remainingObservationBudget - marker.length,
        );
        continue;
      }
      emittedObservationKeys.add(observationKey);
      pendingUniqueKeys.delete(callKey);
      remainingUnique = Math.max(1, remainingUnique);
      const markerLength = full
        ? minimumToolObservationLength(
            full.content,
            execution.succeeded,
            call.name,
          )
        : observationMarker('truncated', execution.succeeded).length;
      const fairShare = Math.max(
        1,
        Math.floor(remainingObservationBudget / remainingUnique),
      );
      const reserveForRemaining = [...pendingUniqueKeys].reduce(
        (total, key) => total + (minimumByKey.get(key) ?? 0),
        0,
      );
      const availableAfterReserve = Math.max(
        0,
        remainingObservationBudget - reserveForRemaining,
      );
      const allocation = Math.max(
        1,
        Math.min(
          remainingObservationBudget,
          Math.max(markerLength, Math.min(fairShare, availableAfterReserve)),
        ),
      );
      const fitted = full
        ? fitObservationWithinBudget(
            full.content,
            allocation,
            execution.succeeded,
          )
        : {
            content: observationMarkerWithinBudget(
              execution.succeeded ? 'truncated' : 'fallback',
              execution.succeeded,
              allocation,
            ),
            wasTruncated: true,
          };
      allocatedByKey.set(resultKey, fitted.content);
      outcomesByKey.set(
        resultKey,
        full?.outcome === 'fallback'
          ? 'fallback'
          : full?.wasTruncated || fitted.wasTruncated
            ? 'truncated'
            : 'kept',
      );
      remainingObservationBudget = Math.max(
        0,
        remainingObservationBudget - fitted.content.length,
      );
      remainingUnique -= 1;
    }

    const results = toolCalls.map((call) => {
      const key = this.toolCallKey(call);
      const result = resultsByKey.get(key) ?? {
        observation: this.missingObservation(call.name),
        succeeded: false,
      };
      const resultKey = `${call.id}:${key}`;
      const outcome = outcomesByKey.get(resultKey) ?? 'fallback';
      this.metrics.observationOutcomeInc?.(
        isAgentToolName(call.name) ? call.name : 'unknown',
        outcome,
      );
      return {
        toolCallId: call.id,
        toolName: call.name,
        content:
          allocatedByKey.get(resultKey) ??
          observationMarker('fallback', result.succeeded),
        succeeded: result.succeeded,
        ...(boundedToolDisclosures.has(key)
          ? { boundedDisclosure: boundedToolDisclosures.get(key) }
          : {}),
      };
    });

    return {
      results,
      executedCount,
      successfulToolNames,
      boundedToolDisclosures,
    };
  }

  private toolCallKey(call: { name: string; arguments: string }): string {
    const validated = parseAndValidateToolArguments(
      call.name,
      call.arguments || '{}',
    );
    return `${call.name}:${
      validated.ok
        ? canonicalizeToolArguments(validated.requestedArgs ?? validated.args)
        : call.arguments || '{}'
    }`;
  }

  private missingObservation(
    toolName: string,
  ): ReturnType<typeof reduceToolObservation> {
    return reduceToolObservation({
      toolName,
      error: 'tool execution did not produce a result',
      ok: false,
      maxChars: 8_000,
    });
  }
}
