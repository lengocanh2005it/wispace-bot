import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmProviderError,
  LlmMessage,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import {
  isPlatformApiError,
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '../../openai-error.utils';
import { isAbortError } from '../../retry.utils';
import {
  toOpenAiTools,
  toOpenAiMessages,
  fromOpenAiToolCalls,
  fromOpenAiUsage,
} from './openai.mapper';
import {
  validateLlmProviderModel,
  type LlmProviderPolicy,
} from '../provider-policy';

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
    private readonly getModel: () => string | undefined = () => DEFAULT_MODEL,
    private readonly getBaseUrl?: () => string | undefined,
    providerName?: string,
    private readonly policy?: LlmProviderPolicy,
  ) {
    this.providerName = providerName ?? 'openai';
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey()?.trim());
  }

  getDefaultModel(): string {
    return this.resolveModel();
  }

  // -----------------------------------------------------------------------
  // Sync — JSON generation
  // -----------------------------------------------------------------------

  async generateJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    const model = this.resolveModel(request.model);
    const client = this.getClientOrThrow();
    request.attemptBudget?.consume();
    try {
      const response = await client.chat.completions.create(
        {
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
        },
        request.signal ? { signal: request.signal } : undefined,
      );

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
    } finally {
      request.attemptBudget?.completeProviderAttempt();
    }
  }

  // -----------------------------------------------------------------------
  // Sync — tool-calling chat (single round)
  // -----------------------------------------------------------------------

  async chatWithTools(
    request: LlmToolChatRequest,
  ): Promise<LlmToolChatResponse> {
    const model = this.resolveModel(request.model);
    const client = this.getClientOrThrow();
    request.attemptBudget?.consume();
    try {
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
    } finally {
      request.attemptBudget?.completeProviderAttempt();
    }
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  isRetryableError(error: unknown): boolean {
    if (isAbortError(error)) return false;
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
    if (this.isBadRequestError(error)) {
      return {
        provider: this.providerName,
        retryable: false,
        reason: 'bad_request',
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
      const apiKey = this.getApiKey()?.trim();
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

  private resolveModel(requestModel?: string): string {
    const model = (requestModel ?? this.getModel())?.trim();
    if (!model) {
      throw new Error(`LLM provider ${this.providerName} model is empty`);
    }
    return this.policy
      ? validateLlmProviderModel(this.providerName, model, this.policy, 'model')
      : model;
  }

  private isServerError(error: unknown): boolean {
    return isOpenAiServerError(error);
  }

  private isAuthError(error: unknown): boolean {
    if (isPlatformApiError(error)) return false;
    if (typeof error !== 'object' || error === null) return false;
    const e = error as Record<string, unknown>;
    return e['status'] === 401 || e['status'] === 403;
  }

  private isBadRequestError(error: unknown): boolean {
    if (isPlatformApiError(error)) return false;
    const status = this.getErrorStatus(error);
    return status === 400 || status === 422;
  }

  private isQuotaExhaustedError(error: unknown): boolean {
    if (isPlatformApiError(error)) return false;
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
