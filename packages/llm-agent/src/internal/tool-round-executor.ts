import {
  getAgentToolDefinition,
  isAgentToolName,
  parseAndValidateToolArguments,
} from '../agent.tools';
import type { AgentMetricsPort, ToolExecutorPort } from '../ports';
import {
  fitToolObservation,
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
}

export interface ToolRoundExecution {
  results: ToolRoundResult[];
  /** Number of executor calls actually started (deduplicated and policy-allowed). */
  executedCount: number;
  /** One entry per successful deduplicated execution, preserving tool-name multiplicity. */
  successfulToolNames: string[];
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
    const successfulToolNames: string[] = [];
    for (const call of uniqueCalls) {
      const result = resultsByKey.get(this.toolCallKey(call)) ?? {
        observation: this.missingObservation(call.name),
        succeeded: false,
      };
      fullByKey.set(this.toolCallKey(call), result.observation);
      if (result.succeeded) successfulToolNames.push(call.name);
      const injection = result.observation.injection;
      if (injection) {
        options.onInjection?.(
          injection.reason,
          injection.rawPreview,
          call.name,
        );
      }
    }

    const minimumMarkerBudget = toolCalls.reduce((sum, call) => {
      const execution = resultsByKey.get(this.toolCallKey(call));
      return (
        sum +
        observationMarker('truncated', execution?.succeeded ?? false).length
      );
    }, 0);
    let extraBudget = Math.max(0, observationBudget - minimumMarkerBudget);
    let remainingUnique = uniqueCalls.length;
    const emittedObservationKeys = new Set<string>();
    const allocatedByKey = new Map<string, string>();
    const outcomesByKey = new Map<string, ToolObservationOutcome>();

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
        allocatedByKey.set(
          resultKey,
          observationMarker('reused', execution.succeeded),
        );
        outcomesByKey.set(resultKey, 'deduped');
        continue;
      }
      emittedObservationKeys.add(observationKey);
      remainingUnique = Math.max(1, remainingUnique);
      const markerLength = observationMarker(
        'truncated',
        execution.succeeded,
      ).length;
      const allocation = Math.max(
        markerLength,
        markerLength + Math.floor(extraBudget / remainingUnique),
      );
      const fitted = full
        ? fitToolObservation(full.content, allocation)
        : {
            content: observationMarker(
              execution.succeeded ? 'truncated' : 'fallback',
              execution.succeeded,
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
      extraBudget = Math.max(
        0,
        extraBudget - Math.max(0, fitted.content.length - markerLength),
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
      };
    });

    return { results, executedCount, successfulToolNames };
  }

  private toolCallKey(call: { name: string; arguments: string }): string {
    const validated = parseAndValidateToolArguments(
      call.name,
      call.arguments || '{}',
    );
    return `${call.name}:${validated.ok ? validated.canonicalArgs : call.arguments || '{}'}`;
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
