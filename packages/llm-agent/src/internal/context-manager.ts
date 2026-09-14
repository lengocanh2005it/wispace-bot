import { AGENT_TOOLS } from '../agent.tools';
import type { LlmMessage } from '../provider/types';
import {
  isInjectionSanitizeReason,
  sanitizeUntrustedTextForLlm,
} from '../utils/prompt-injection.utils';
import type { ChatHistoryMessage, LlmAgentInput } from '../types';
import { AgentLimits, estimateTokens } from './agent-limits';

const MAX_HISTORY_ENTRY_CHARS = 8_000;

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
}

export interface LoopTrimResult {
  fits: boolean;
  droppedToolNames: string[];
}

export function estimateContextTokens(messages: LlmMessage[]): number {
  return (
    estimateTokens(JSON.stringify(messages)) +
    estimateTokens(JSON.stringify(AGENT_TOOLS))
  );
}

/**
 * Owns all context construction and trimming decisions. The service only
 * decides what to do when this class reports an impossible fixed context.
 */
export class ContextManager {
  constructor(
    private readonly limits: AgentLimits,
    private readonly hooks: ContextManagerHooks = {},
  ) {}

  build(
    input: LlmAgentInput,
    hooks: ContextManagerHooks = this.hooks,
  ): ContextBuildResult {
    const system: LlmMessage = {
      role: 'system',
      content: `${input.systemPrompt}\n\n${REASONING_INSTRUCTION}`,
    };
    const user: LlmMessage = {
      role: 'user',
      content: input.userText.trim(),
    };
    const history = this.sanitizeHistory(input.history ?? [], hooks);
    const selected: ChatHistoryMessage[] = [];
    let droppedHistoryTokens = 0;
    const fixed = [system, user];

    if (estimateContextTokens(fixed) > this.limits.inputTokenBudget) {
      return { messages: fixed, fits: false, droppedHistoryTokens: 0 };
    }

    // History is bounded by the most recent entries. The history caps in the
    // stores keep this scan small; clarity is more valuable than a second
    // token accumulator that can drift from estimateContextTokens().
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!entry) continue;
      const candidate = [
        system,
        ...this.toMessages([...selected, entry]),
        user,
      ];
      if (estimateContextTokens(candidate) <= this.limits.inputTokenBudget) {
        selected.unshift(entry);
      } else {
        droppedHistoryTokens += estimateTokens(entry.content);
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
      content: entry.content,
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
