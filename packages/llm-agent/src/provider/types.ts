// ---------------------------------------------------------------------------
// Provider-agnostic LLM types
// These types describe the contract between the harness (agentic loop) and
// any LLM provider. They contain zero imports from the `openai` npm package.
// ---------------------------------------------------------------------------

/** Supported LLM providers (for metadata/routing, not exhaustive). */
export type LlmProvider =
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'minimax'
  | 'anthropic'
  | 'gemini'
  | 'local';

/** Feature keys for usage tracking — canonical source. */
export type LlmFeature = 'FREE_FORM_CHAT' | 'STUDENT_REPORT' | 'STUDY_REMINDER';

// ---------------------------------------------------------------------------
// Tool definitions (provider-agnostic, plain JSON Schema)
// ---------------------------------------------------------------------------

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's parameters. */
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type LlmMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  /** Provider-specific tool call id (preserved across round-trips). */
  id: string;
  /** Tool function name. */
  name: string;
  /** JSON-encoded arguments string. */
  arguments: string;
}

export interface LlmMessage {
  role: LlmMessageRole;
  content?: string;
  /** Present when role='assistant' and model invoked tool(s). */
  toolCalls?: LlmToolCall[];
  /** Present when role='tool' — must match the corresponding tool call id. */
  toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Usage & metadata
// ---------------------------------------------------------------------------

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from OpenAI's automatic prompt cache (subset of promptTokens), if reported. */
  cachedTokens?: number;
}

export interface LlmProviderMetadata {
  provider: string;
  model: string;
  responseId?: string;
  usage?: LlmUsage;
}

// ---------------------------------------------------------------------------
// JSON generation (single-shot, for report / reminder)
// ---------------------------------------------------------------------------

export interface LlmJsonRequest {
  feature: LlmFeature;
  model?: string;
  correlationId?: string;
  systemPrompt: string;
  userContent: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmJsonResponse {
  /** Raw LLM output string (may contain JSON or plain text). */
  content: string;
  metadata: LlmProviderMetadata;
}

// ---------------------------------------------------------------------------
// Tool-calling chat (multi-round agentic loop)
// ---------------------------------------------------------------------------

export interface LlmToolChatRequest {
  feature: LlmFeature;
  model?: string;
  correlationId?: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmToolChatResponse {
  /**
   * Full assistant message for the caller to push into the messages array
   * on the next round. message.toolCalls contains the tool invocations (if any).
   * Callers should NOT read tool calls from two separate places.
   */
  message: LlmMessage;
  /** Final text reply when the model did not invoke any tools. */
  content?: string;
  metadata: LlmProviderMetadata;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export type LlmStreamEvent =
  | { type: 'delta'; textDelta: string }
  | { type: 'tool_call_start'; toolCall: LlmToolCall }
  | { type: 'tool_call_delta'; toolCallId: string; argsDelta: string }
  | { type: 'done'; response: LlmToolChatResponse }
  | { type: 'error'; error: unknown };

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export interface LlmProviderError {
  provider: string;
  status?: number;
  code?: string;
  retryable: boolean;
  reason:
    | 'rate_limit'
    | 'timeout'
    | 'server_error'
    | 'network'
    | 'auth'
    | 'bad_request'
    | 'quota_exceeded'
    | 'unknown';
}
