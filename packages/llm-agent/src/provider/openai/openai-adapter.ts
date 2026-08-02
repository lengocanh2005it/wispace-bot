import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmStreamEvent,
  LlmProviderError,
  LlmMessage,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '../../utils/openai-error.utils';
import {
  toOpenAiTools,
  toOpenAiMessages,
  fromOpenAiToolCalls,
  fromOpenAiUsage,
} from './openai.mapper';

const DEFAULT_MODEL = 'gpt-5.4';

/**
 * OpenAI (and OpenAI-compatible) adapter for the LlmProviderAdapter contract.
 * All OpenAI SDK-specific logic lives here — the rest of the codebase never
 * touches the `openai` npm package directly.
 */
export class OpenAiAdapter implements LlmProviderAdapter {
  readonly providerName: string;
  private client: OpenAI | null = null;

  constructor(
    private readonly getApiKey: () => string | undefined,
    private readonly getModel: () => string = () => DEFAULT_MODEL,
    private readonly getBaseUrl?: () => string | undefined,
    providerName?: string,
  ) {
    this.providerName = providerName ?? 'openai';
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  getDefaultModel(): string {
    return this.getModel();
  }

  // -----------------------------------------------------------------------
  // Sync — JSON generation
  // -----------------------------------------------------------------------

  async generateJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    const client = this.getClientOrThrow();
    const model = request.model ?? this.getDefaultModel();

    const response = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userContent },
      ],
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
      ...(request.maxOutputTokens !== undefined && {
        max_completion_tokens: request.maxOutputTokens,
      }),
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('LLM provider returned empty content');
    }

    return {
      content,
      metadata: {
        provider: this.providerName,
        model,
        responseId: response.id,
        usage: fromOpenAiUsage(response.usage),
      },
    };
  }

  // -----------------------------------------------------------------------
  // Sync — tool-calling chat (single round)
  // -----------------------------------------------------------------------

  async chatWithTools(
    request: LlmToolChatRequest,
  ): Promise<LlmToolChatResponse> {
    const client = this.getClientOrThrow();
    const model = request.model ?? this.getDefaultModel();

    const response = await client.chat.completions.create(
      {
        model,
        messages: toOpenAiMessages(request.messages),
        tools: toOpenAiTools(request.tools),
        tool_choice: request.toolChoice ?? 'auto',
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
        ...(request.maxOutputTokens !== undefined && {
          max_completion_tokens: request.maxOutputTokens,
        }),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    return fromOpenAiCompletion(response, this.providerName, model);
  }

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  async *chatStream(
    request: LlmToolChatRequest,
  ): AsyncIterable<LlmStreamEvent> {
    const client = this.getClientOrThrow();
    const model = request.model ?? this.getDefaultModel();

    const stream = await client.chat.completions.create(
      {
        model,
        messages: toOpenAiMessages(request.messages),
        tools: toOpenAiTools(request.tools),
        tool_choice: request.toolChoice ?? 'auto',
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
        ...(request.maxOutputTokens !== undefined && {
          max_completion_tokens: request.maxOutputTokens,
        }),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    // Accumulator for the final response
    const toolCallsAccum = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let contentAccum = '';
    let finalUsage: ChatCompletion['usage'] = undefined;
    let finalResponseId = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      finalResponseId = chunk.id;

      if (chunk.usage) {
        finalUsage = chunk.usage;
      }

      if (delta?.content) {
        contentAccum += delta.content;
        yield { type: 'delta', textDelta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallsAccum.get(idx);

          if (!existing) {
            const toolCall = {
              id: tc.id ?? `tool_call_${idx}`,
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            };
            toolCallsAccum.set(idx, toolCall);
            if (toolCall.name) {
              yield {
                type: 'tool_call_start',
                toolCall: { ...toolCall },
              };
            }
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              yield {
                type: 'tool_call_delta',
                toolCallId: existing.id,
                argsDelta: tc.function.arguments,
              };
            }
          }
        }
      }
    }

    // Build the final LlmMessage
    const toolCalls =
      toolCallsAccum.size > 0
        ? Array.from(toolCallsAccum.values()).map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          }))
        : undefined;

    const message: LlmMessage = {
      role: 'assistant',
      content: contentAccum || undefined,
      toolCalls,
    };

    const response: LlmToolChatResponse = {
      message,
      content: toolCalls ? undefined : contentAccum || undefined,
      metadata: {
        provider: this.providerName,
        model,
        responseId: finalResponseId,
        usage: fromOpenAiUsage(finalUsage),
      },
    };

    yield { type: 'done', response };
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  isRetryableError(error: unknown): boolean {
    return this.isRateLimitError(error) || this.isServerError(error);
  }

  isRateLimitError(error: unknown): boolean {
    return isOpenAiRateLimitError(error);
  }

  normalizeError(error: unknown): LlmProviderError {
    if (this.isQuotaExhaustedError(error)) {
      return {
        provider: this.providerName,
        retryable: false,
        reason: 'quota_exceeded',
        status: this.getErrorStatus(error),
      };
    }
    if (this.isRateLimitError(error)) {
      return {
        provider: this.providerName,
        retryable: true,
        reason: 'rate_limit',
        status: this.getErrorStatus(error),
      };
    }
    if (this.isServerError(error)) {
      return {
        provider: this.providerName,
        retryable: true,
        reason: 'server_error',
        status: this.getErrorStatus(error),
      };
    }
    if (this.isAuthError(error)) {
      return {
        provider: this.providerName,
        retryable: false,
        reason: 'auth',
        status: this.getErrorStatus(error),
      };
    }
    return {
      provider: this.providerName,
      retryable: false,
      reason: 'unknown',
      status: this.getErrorStatus(error),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getClientOrThrow(): OpenAI {
    if (!this.client) {
      const apiKey = this.getApiKey();
      if (!apiKey) {
        throw new Error('LLM provider not configured: missing API key');
      }
      this.client = new OpenAI({
        apiKey,
        baseURL: this.getBaseUrl?.(),
      });
    }
    return this.client;
  }

  private isPlatformApiError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'MessengerApiError' ||
        error.name === 'DiscordApiError' ||
        error.name === 'ZaloApiError')
    );
  }

  private isServerError(error: unknown): boolean {
    return isOpenAiServerError(error);
  }

  private isAuthError(error: unknown): boolean {
    if (this.isPlatformApiError(error)) return false;
    if (typeof error !== 'object' || error === null) return false;
    const e = error as Record<string, unknown>;
    return e['status'] === 401 || e['status'] === 403;
  }

  private isQuotaExhaustedError(error: unknown): boolean {
    if (this.isPlatformApiError(error)) return false;
    if (typeof error !== 'object' || error === null) return false;
    const e = error as Record<string, unknown>;
    const status = e['status'];
    if (status === 402) return true;
    if (status === 429 || status === 400) {
      const msg = typeof e['message'] === 'string' ? e['message'] : '';
      const code = typeof e['code'] === 'string' ? e['code'] : '';
      if (
        /insufficient.?quota|insufficient.?credit|insufficient.?balance|billing/i.test(
          msg,
        )
      )
        return true;
      if (
        /insufficient.?quota|insufficient.?credit|insufficient.?balance|billing/i.test(
          code,
        )
      )
        return true;
    }
    return false;
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const status = (error as Record<string, unknown>)['status'];
    return typeof status === 'number' ? status : undefined;
  }
}

// ---------------------------------------------------------------------------
// Completion → LlmToolChatResponse mapper
// ---------------------------------------------------------------------------

function fromOpenAiCompletion(
  response: ChatCompletion,
  providerName: string,
  model: string,
): LlmToolChatResponse {
  const choice = response.choices[0]?.message;
  if (!choice) {
    throw new Error('LLM provider returned empty assistant message');
  }

  const toolCalls =
    choice.tool_calls && choice.tool_calls.length > 0
      ? fromOpenAiToolCalls(choice.tool_calls)
      : undefined;

  const message: LlmMessage = {
    role: 'assistant',
    content: choice.content ?? undefined,
    toolCalls,
  };

  return {
    message,
    content: toolCalls ? undefined : choice.content?.trim() || undefined,
    metadata: {
      provider: providerName,
      model,
      responseId: response.id,
      usage: fromOpenAiUsage(response.usage),
    },
  };
}
