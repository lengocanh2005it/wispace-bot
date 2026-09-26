import { AGENT_TOOLS } from '../agent.tools';
import type { LlmMessage } from '../provider/types';
import {
  isInjectionSanitizeReason,
  sanitizeUntrustedTextForLlm,
} from '../safety/prompt-injection.utils';
import type {
  ChatHistoryMessage,
  LlmAgentInput,
  LlmAgentPromptParts,
} from '../types';
import { composeChatSystemPrompt } from '../chat-system-prompt';
import { AgentLimits, estimateTokens } from './agent-limits';

const MAX_HISTORY_ENTRY_CHARS = 8_000;
const RECENT_FAILED_OBSERVATION_ROUNDS = 3;
const REPLAYED_TOOL_SUMMARY_MARKER =
  '[Previous-turn tool summary; may be stale. Fresh current-turn tool data takes precedence.]';

interface ToolObservationMetadata {
  originRound: number;
  succeeded: boolean;
  downgraded: boolean;
}

function staleObservationMarker(
  succeeded: boolean,
  originRound: number,
): string {
  return JSON.stringify(
    succeeded
      ? {
          ok: true,
          _observation: 'truncated',
          reason: 'age',
          originRound,
        }
      : {
          ok: false,
          error: 'observation_unavailable',
          _observation: 'truncated',
          reason: 'age',
          originRound,
        },
  );
}

/** Injected after the platform system prompt to guide the model's reasoning. */
export const REASONING_INSTRUCTION = `
---
Trước khi trả lời, hãy:
1. Xác định ý định của học viên (tiến độ học, lịch học, đổi lịch, hay câu hỏi chung).
2. Nếu cần dữ liệu từ nhiều tool, hãy gọi tất cả trong cùng một lượt để tiết kiệm thời gian.
3. Chỉ trả lời bằng văn bản sau khi đã có đủ dữ liệu cần thiết.
`.trim();

export interface ContextManagerHooks {
  onHistoryInjection?: (reason: string, text: string) => void;
  onHistoryTrimmed?: (droppedTokens: number) => void;
}

export interface ContextBuildResult {
  messages: LlmMessage[];
  fits: boolean;
  droppedHistoryTokens: number;
  droppedContextParts: ContextPartName[];
}

export type ContextPartName = 'learner_profile' | 'reasoning_instruction';

export interface LoopTrimResult {
  fits: boolean;
  droppedToolNames: string[];
}

export const CONTEXT_TOOL_DEFINITIONS = AGENT_TOOLS.map(
  ({ name, description, parameters }) => ({ name, description, parameters }),
);

export function estimateContextTokens(messages: LlmMessage[]): number {
  return (
    estimateTokens(JSON.stringify(messages)) +
    estimateTokens(JSON.stringify(CONTEXT_TOOL_DEFINITIONS))
  );
}

/**
 * Owns all context construction and trimming decisions. The service only
 * decides what to do when this class reports an impossible fixed context.
 */
export class ContextManager {
  private readonly observationMetadata = new WeakMap<
    LlmMessage,
    ToolObservationMetadata
  >();

  constructor(
    private readonly limits: AgentLimits,
    private readonly hooks: ContextManagerHooks = {},
  ) {}

  build(
    input: LlmAgentInput,
    hooks: ContextManagerHooks = this.hooks,
  ): ContextBuildResult {
    const promptParts = input.systemPromptParts;
    const droppedContextParts: ContextPartName[] = [];
    let includeLearnerProfile = Boolean(promptParts?.learnerProfile);
    let includeReasoningInstruction = true;
    let system = this.buildSystemMessage(
      input.systemPrompt,
      promptParts,
      includeLearnerProfile,
      includeReasoningInstruction,
    );
    const user: LlmMessage = {
      role: 'user',
      content: input.userText.trim(),
    };
    const history = this.sanitizeHistory(input.history ?? [], hooks);
    const selected: ChatHistoryMessage[] = [];
    let droppedHistoryTokens = 0;
    const allHistoryMessages = this.toMessages(history);

    const exceedsBudget = (candidateSystem: LlmMessage): boolean =>
      estimateContextTokens([candidateSystem, ...allHistoryMessages, user]) >
      this.limits.inputTokenBudget;

    if (includeLearnerProfile && exceedsBudget(system)) {
      includeLearnerProfile = false;
      droppedContextParts.push('learner_profile');
      system = this.buildSystemMessage(
        input.systemPrompt,
        promptParts,
        includeLearnerProfile,
        includeReasoningInstruction,
      );
    }

    if (includeReasoningInstruction && exceedsBudget(system)) {
      includeReasoningInstruction = false;
      droppedContextParts.push('reasoning_instruction');
      system = this.buildSystemMessage(
        input.systemPrompt,
        promptParts,
        includeLearnerProfile,
        includeReasoningInstruction,
      );
    }

    const fixed = [system, user];

    if (estimateContextTokens(fixed) > this.limits.inputTokenBudget) {
      return {
        messages: fixed,
        fits: false,
        droppedHistoryTokens: 0,
        droppedContextParts,
      };
    }

    const fitsHistory = (entries: ChatHistoryMessage[]): boolean =>
      estimateContextTokens([system, ...this.toMessages(entries), user]) <=
      this.limits.inputTokenBudget;

    if (fitsHistory(history)) {
      selected.push(...history);
    } else {
      const newest = history.at(-1);
      if (newest && fitsHistory([newest])) {
        selected.push(...history);
        // Drop a contiguous oldest prefix so a too-large middle entry cannot
        // make us retain an older entry while losing a newer one.
        while (selected.length > 0 && !fitsHistory(selected)) {
          const removed = selected.shift();
          if (removed) {
            droppedHistoryTokens += estimateTokens(removed.content);
          }
        }
      } else {
        // If the newest entry cannot fit by itself, retain the existing
        // newest-to-oldest scan so smaller older entries can still be used.
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i];
          if (!entry) continue;
          const candidate = [
            system,
            ...this.toMessages([...selected, entry]),
            user,
          ];
          if (
            estimateContextTokens(candidate) <= this.limits.inputTokenBudget
          ) {
            selected.unshift(entry);
          } else {
            droppedHistoryTokens += estimateTokens(entry.content);
          }
        }
      }
    }

    if (droppedHistoryTokens > 0) {
      hooks.onHistoryTrimmed?.(droppedHistoryTokens);
    }

    const messages = [system, ...this.toMessages(selected), user];
    return {
      messages,
      fits: estimateContextTokens(messages) <= this.limits.inputTokenBudget,
      droppedHistoryTokens,
      droppedContextParts,
    };
  }

  private buildSystemMessage(
    systemPrompt: string,
    promptParts: LlmAgentPromptParts | undefined,
    includeLearnerProfile: boolean,
    includeReasoningInstruction: boolean,
  ): LlmMessage {
    const composedPrompt = promptParts
      ? composeChatSystemPrompt({
          ...promptParts,
          learnerProfile: includeLearnerProfile
            ? promptParts.learnerProfile
            : undefined,
        })
      : systemPrompt;
    return {
      role: 'system',
      content: includeReasoningInstruction
        ? `${composedPrompt}\n\n${REASONING_INSTRUCTION}`
        : composedPrompt,
    };
  }

  trimLoopMessages(
    messages: LlmMessage[],
    loopStartIndex: number,
  ): LoopTrimResult {
    const droppedToolNames: string[] = [];
    while (
      estimateContextTokens(messages) > this.limits.inputTokenBudget &&
      messages.length > loopStartIndex
    ) {
      const assistantIndex = this.findFirstToolCall(messages, loopStartIndex);
      const dropIndex = assistantIndex >= 0 ? assistantIndex : loopStartIndex;
      const removed = messages.splice(dropIndex, 1)[0];
      if (!removed) break;

      if (removed.toolCalls?.length) {
        droppedToolNames.push(...removed.toolCalls.map((call) => call.name));
        while (
          messages.length > dropIndex &&
          messages[dropIndex]?.role === 'tool'
        ) {
          messages.splice(dropIndex, 1);
        }
        messages.splice(dropIndex, 0, {
          role: 'assistant',
          content: JSON.stringify({
            _observation: 'dropped',
            tools: [...new Set(removed.toolCalls.map((call) => call.name))],
            count: removed.toolCalls.length,
          }),
        });
      }
    }

    return {
      fits: estimateContextTokens(messages) <= this.limits.inputTokenBudget,
      droppedToolNames,
    };
  }

  observationBudget(messages: LlmMessage[]): number {
    return this.limits.observationCharBudget(estimateContextTokens(messages));
  }

  trackToolObservation(
    message: LlmMessage,
    metadata: { originRound: number; succeeded: boolean },
  ): void {
    if (message.role !== 'tool') return;
    this.observationMetadata.set(message, {
      ...metadata,
      downgraded: false,
    });
  }

  downgradeStaleObservations(
    messages: LlmMessage[],
    loopStartIndex: number,
    currentRound: number,
  ): void {
    for (
      let index = Math.max(0, loopStartIndex);
      index < messages.length;
      index++
    ) {
      const message = messages[index];
      if (!message || message.role !== 'tool') continue;

      const metadata = this.observationMetadata.get(message);
      if (!metadata || metadata.downgraded) continue;

      const age = currentRound - metadata.originRound;
      if (
        age < this.limits.staleObservationRounds ||
        age < 0 ||
        (!metadata.succeeded && age < RECENT_FAILED_OBSERVATION_ROUNDS)
      ) {
        continue;
      }

      const marker = staleObservationMarker(
        metadata.succeeded,
        metadata.originRound,
      );
      if (message.content === marker) {
        metadata.downgraded = true;
        continue;
      }

      message.content = marker;
      metadata.downgraded = true;
    }
  }

  private sanitizeHistory(
    history: ChatHistoryMessage[],
    hooks: ContextManagerHooks,
  ): ChatHistoryMessage[] {
    return history.map((entry) => {
      const clean = sanitizeUntrustedTextForLlm(entry.content, {
        maxChars: MAX_HISTORY_ENTRY_CHARS,
      });
      if (clean.wasSanitized && isInjectionSanitizeReason(clean.reason)) {
        hooks.onHistoryInjection?.(clean.reason ?? 'unknown', entry.content);
      }
      return clean.wasSanitized ? { ...entry, content: clean.text } : entry;
    });
  }

  private toMessages(history: ChatHistoryMessage[]): LlmMessage[] {
    return history.map((entry) => ({
      role: entry.role === 'tool_summary' ? 'assistant' : entry.role,
      content:
        entry.role === 'tool_summary'
          ? `${REPLAYED_TOOL_SUMMARY_MARKER}\n${entry.content}`
          : entry.content,
    }));
  }

  private findFirstToolCall(
    messages: LlmMessage[],
    loopStartIndex: number,
  ): number {
    for (let i = loopStartIndex; i < messages.length; i++) {
      if (messages[i]?.role === 'assistant' && messages[i]?.toolCalls?.length) {
        return i;
      }
    }
    return -1;
  }
}
