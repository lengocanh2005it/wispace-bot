# LLM Provider Adapter — Decouple Function Calling from OpenAI

## Status

Implemented (PR #32 — `LlmProviderAdapter` pattern with OpenAI, OpenRouter, MiniMax adapters + failover)

## Context

`packages/llm-agent` is the core agentic loop shared across all 3 bots (Messenger, Discord, Zalo). It handles function calling (tool definitions, tool call parsing, tool result round-trips) with LLM providers.

Currently, the entire agentic loop is tightly coupled to OpenAI:

- `LlmAgentService` instantiates `new OpenAI({ apiKey })` and calls `client.chat.completions.create()` directly
- Tool definitions use OpenAI's `ChatCompletionTool[]` type
- Response parsing hardcodes `response.choices[0].message.tool_calls` — OpenAI-specific shape
- `LlmAgentConfig` has an OpenAI-specific `apiKey` field
- Error classification utilities check OpenAI-specific `error.name` / `error.status` properties
- The `openai` npm package is a direct dependency of the core package

This means switching to any other LLM provider (Minimax, Anthropic, Google Gemini, local models) requires rewriting the agentic loop. The codebase already established a clean port/adapter pattern (`ToolExecutorPort`, `LlmExecutionPort`) but stopped short of abstracting the LLM provider itself.

ADR-0002 states: "`packages/llm-agent` is pure TypeScript with no NestJS imports. It can be used with any bot framework." This refactor strengthens that guarantee by also removing the OpenAI SDK dependency from the core loop.

## Decision

Introduce a `LlmProviderAdapter` interface that abstracts the LLM provider behind a provider-agnostic contract. The agentic loop (`LlmAgentService`) only works with provider-agnostic types; each provider implements an adapter that converts to/from its native format.

### Provider-agnostic types

```typescript
interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string; // for role='tool'
  toolCalls?: LlmToolCall[]; // for assistant with tool calls
}

interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

interface LlmResponse {
  text?: string;
  toolCalls?: LlmToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}
```

### Adapter interface (sync + streaming)

```typescript
interface LlmProviderAdapter {
  readonly providerName: string;

  // Sync — full response
  chat(params: {
    model: string;
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    toolChoice?: 'auto' | 'none' | 'required';
  }): Promise<LlmResponse>;

  // Streaming — emits events as tokens arrive
  chatStream(params: {
    model: string;
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    toolChoice?: 'auto' | 'none' | 'required';
  }): AsyncIterable<LlmStreamEvent>;

  isRetryableError(error: unknown): boolean;
  isRateLimitError(error: unknown): boolean;
}

// Streaming events
type LlmStreamEvent =
  | { type: 'delta'; textDelta: string }
  | { type: 'tool_call_start'; toolCall: LlmToolCall }
  | { type: 'tool_call_delta'; toolCallId: string; argsDelta: string }
  | { type: 'done'; response: LlmResponse }
  | { type: 'error'; error: unknown };
```

Implementation note: the shipped interface names the synchronous operations `generateJson()` and `chatWithTools()` and also includes `isConfigured()`, `getDefaultModel()`, and `normalizeError()`. The sketch above records the provider-neutral contract shape; these are the current method names.

### Adapter responsibilities

Each adapter handles:

1. **Tool definition conversion**: `LlmToolDefinition[]` → provider-native format (e.g. OpenAI `ChatCompletionTool[]`, Anthropic `Tool[]`)
2. **Message conversion**: `LlmMessage[]` → provider-native message format
3. **Response normalization**: provider-native response → `LlmResponse`
4. **Streaming normalization**: provider-native stream → `AsyncIterable<LlmStreamEvent>`
5. **Error classification**: `isRetryableError()` / `isRateLimitError()` using provider-specific error shapes

### OpenAI adapter (reference implementation)

- Converts `LlmToolDefinition` → `ChatCompletionTool`
- Converts `LlmMessage` → `ChatCompletionMessageParam`
- Converts `ChatCompletion` → `LlmResponse`
- Moves existing `openai-error.utils.ts` logic into adapter methods

### Agentic loop with streaming

The agent loop emits events during execution, allowing downstream consumers to react in real-time (typing indicators, progressive display, tool progress).

```typescript
type AgentEvent =
  | LlmStreamEvent // proxied from adapter
  | { type: 'tool_start'; toolName: string } // before tool execution
  | { type: 'tool_end'; toolName: string } // after tool execution
  | { type: 'round_start'; round: number } // new tool round
  | { type: 'round_end'; round: number }; // round completed
```

Loop behavior:

1. For each round: call `adapter.chatStream()`, yield all `LlmStreamEvent`s
2. Accumulate tool calls from stream (handle `tool_call_start` / `tool_call_delta`)
3. If no tool calls → yield `done`, return
4. Execute each tool via `ToolExecutorPort`, yield `tool_start`/`tool_end`
5. Append tool results to messages, continue loop (max `maxToolRounds`)
6. Guard: if stream errors mid-tool-call → yield `error`, return

Implementation status: provider adapters expose `chatStream()`. `LlmAgentService.replyStream()` currently reuses the non-streaming agent rounds and emits the final text as one `delta`; native token-by-token agent-loop streaming remains Phase 2.

### Agentic loop changes

- `LlmAgentService` receives `LlmProviderAdapter` via constructor (no more `apiKey`)
- `AGENT_TOOLS` type changes from `ChatCompletionTool[]` to `LlmToolDefinition[]`
- Response handling uses provider-agnostic response types instead of `ChatCompletion`
- Tool result messages constructed as `LlmMessage` with `role: 'tool'`
- `LlmAgentService` exposes sync `reply()` and a `replyStream()` API; adapters expose sync `chatWithTools()` and streaming `chatStream()` operations.

### Config

- `LlmAgentConfig` loses `apiKey` — adapter handles auth internally
- New env var: `LLM_PROVIDER` (default: `openai`)
- Provider-specific env vars remain per-adapter (e.g. `OPENAI_API_KEY`, `MINIMAX_API_KEY`)

## Alternatives considered

| Alternative                                       | Reason for rejection                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Keep OpenAI, add Minimax as secondary via wrapper | Still couples core to OpenAI types; wrapper adds indirection without removing dependency                          |
| Use LangChain/Vercel AI SDK as abstraction        | Heavy dependencies; adds abstraction we don't control; already have clean port pattern that just needs completing |
| Provider-specific `LlmAgentService` subclasses    | Duplication of agentic loop logic; violates DRY; harder to maintain                                               |
| Direct `fetch` with per-provider HTTP calls       | Reinvents what the OpenAI SDK already does; error handling, retries, streaming become our problem                 |

## Consequences

- **Positive**: Adding a new LLM provider requires only implementing `LlmProviderAdapter` — no changes to `LlmAgentService` or tool executors
- **Positive**: `LlmAgentService` and provider-agnostic types no longer import OpenAI SDK types. The `@wispace/llm-agent` package still declares `openai` because its OpenAI adapter ships in the same package.
- **Positive**: Stronger guarantee for ADR-0002's "framework-agnostic" claim
- **Positive**: Provider-specific error handling is encapsulated, not scattered across utils
- **Positive**: Adapter-level streaming support normalizes provider streams; native token-by-token agent-loop streaming remains a follow-up.
- **Positive**: The `replyStream()`/agent-event API decouples the core loop from transport consumers.
- **Negative**: One more interface to maintain; slightly more indirection in the call chain
- **Negative**: Existing tests in `agent.service.spec.ts` need mock adapter instead of mock OpenAI response
- **Negative**: Provider/failover adapter error classification and execution-layer retry policies must remain aligned.
- **Negative**: Streaming adds edge cases: tool JSON errors mid-stream, partial tool arguments, loop termination detection
- **Negative**: `AsyncIterable` consumption requires careful cleanup (abort signals) when stream is interrupted

## Scope

- **Phase 1** (this ADR): `LlmProviderAdapter` interface + types + OpenAI adapter (`generateJson()` / `chatWithTools()` sync) + refactor `LlmAgentService`
- **Phase 2** (follow-up): Wire adapter `chatStream()` into `LlmAgentService` for native token/tool-call streaming plus the `LlmStreamEvent` / `AgentEvent` stream.
- **Phase 3** (follow-up): `@wispace/student-report` abstraction + streaming consumers in Messenger/Discord
- **Phase 4** (implemented): Multi-provider failover routing — see [spec: 2026-07-18-multi-llm-provider-failover](../superpowers/specs/2026-07-18-multi-llm-provider-failover/spec.md)
  - `OpenRouterAdapter` + `MiniMaxAdapter` extending `OpenAiAdapter`
  - `FailoverLlmProviderAdapter` — greedy failover by priority, circuit breaker, quick-retry (150ms × 1) for transient errors, fast-fail (quota/auth) with long cooldown
  - Wired into `LlmExecutionModule` (messenger-bot) and the shared `@wispace/chat-agent` provider wiring (discord-bot/zalo-bot) via `LLM_PROVIDER_FAILOVER_ORDER` env var
  - A single adapter remains direct for callers without failover telemetry or a retry budget; the app wiring wraps it when those shared controls are enabled
