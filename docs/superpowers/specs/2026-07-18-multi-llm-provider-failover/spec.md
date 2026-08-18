# Multi-LLM Provider Failover (OpenRouter + MiniMax)

**Date:** 2026-07-18
**Scope:** `packages/llm-agent` (provider layer) + wiring in `apps/messenger-bot`, `apps/discord-bot`

> **Status note (2026-08-13):** This design is implemented, with two intentional implementation differences from the July proposal: `packages/llm-agent/src/provider/factory.ts` uses provider-labelled `OpenAiAdapter` entries rather than separate OpenRouter/MiniMax classes, and `createLlmProviderAdapterFromEnv` in `from-env.factory.ts` is shared by Discord and Zalo. The current `FailoverLlmProviderAdapter.chatStream()` attempts another candidate when stream iteration fails; the dated non-goal below is therefore historical. The open questions are resolved by the current env defaults and factory wiring described in source.

## Problem

At design time (2026-07-18), each app only configured **one** `LlmProviderAdapter` at boot time (`LLM_PROVIDER` env → `createLlmProviderAdapter()`, see ADR [0006](../../../adr/0006-llm-provider-adapter.md)). When that provider had a runtime failure (out of credits, rate limit, 5xx):

1. `LlmAgentService.withRetry()` (packages/llm-agent) and/or `LlmExecutionService.runWithRetry()` (messenger-bot) or `DiscordAgentService.runWithRetry()` (discord-bot) **retries the same provider** with exponential backoff (default 3–4 attempts).
2. If the error is **out of credits / quota**, retry will definitely fail again — just wastes wait time (actual log: `LLM call failed after 4 attempts` — user waits ~several seconds before receiving fallback message, see [chat fallback thread](../../../../CLAUDE.md) earlier in this session).
3. No second provider is attempted — all chat/report/reminder features are completely dead until an operator tops up credits or changes `.env` + restarts.
4. **Additional bug discovered at design time**: `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts` hardcoded `new OpenAiAdapter(...)` directly, **not** going through `createLlmProviderAdapter()` — Discord bot did not respect the `LLM_PROVIDER` env var even though Messenger bot did. This was fixed during implementation; the current provider binding is in `discord-shared.module.ts`.

## Goals

- Add 2 new adapters: **OpenRouter**, **MiniMax** — both expose OpenAI-compatible APIs (chat completions), so reuse `OpenAiAdapter` as base class like the existing `OpenAiCompatibleAdapter`.
- When multiple providers are configured, **automatic failover**: whichever provider fails (regardless of reason — rate limit, 5xx, out of credits, auth) → immediately try the next provider in the list, **no** waiting for backoff/retry on the failing provider.
- No behavior change when only 1 provider is configured (100% backward compatible, no latency/complexity increase for the current common case).
- No changes to any consumer (`LlmAgentService`, `LlmExecutionService`, `StudyReminderService`, `StudentReportService`, `MessengerAgentService`, `DiscordAgentService`) — all inject via `LLM_PROVIDER_ADAPTER` token : the `LlmProviderAdapter` interface shape stays unchanged, only 1 new implementation is added (`FailoverLlmProviderAdapter`).
- Fix the Discord bot hardcoded OpenAI bug.

## Non-goals

- Historical non-goal: no mid-stream streaming failover for a response already being streamed (`chatStream`). Current `FailoverLlmProviderAdapter` tries the next healthy candidate when stream iteration throws, but cannot retract events already emitted by the failed stream.
- No multi-"round" retry across the full provider list (try A→B→C then loop back to A again). A single failover pass goes through the list **exactly once**. If all fail → throw, existing consumers (chat gateway/dispatch service) already have fallback messages ready.
- No Anthropic/Gemini addition in this scope (ADR-0006 Phase 4 mentions them but user only requested OpenRouter + MiniMax this time).

## Design

### 1. Error classification — add `reason: 'quota_exceeded'` + retry-before-failover policy

`packages/llm-agent/src/provider/types.ts` — `LlmProviderError.reason` currently has `'rate_limit' | 'server_error' | 'auth' | 'unknown'`. Add `'quota_exceeded'`.

`OpenAiAdapter.normalizeError()` (base class shared for OpenAI/OpenAI-compatible/OpenRouter/MiniMax) detects quota-exhausted via:

- HTTP status `402` (Payment Required — OpenRouter uses this code when out of credits).
- HTTP status `429` **and** body/message containing `insufficient_quota` / `insufficient credit` / `insufficient balance` (OpenAI returns `insufficient_quota` in `error.code`; MiniMax returns `base_resp.status_code` separately — **needs verification during implementation**, see Open Questions).

**Policy — not all errors are treated equally.** The goal is failover as fast as possible, but still give transient errors (network hiccup, burst rate-limit) one cheap chance before completely abandoning that provider for this turn:

| `reason`         | Policy                                         | Number of attempts **on that provider** before failover       | Cooldown after giving up on this provider                                                                |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `quota_exceeded` | **FAST_FAIL** — failover immediately, no retry | 1 (no retry)                                                  | Long (`FAILOVER_COOLDOWN_LONG_MS`, default 10 minutes) — out of credits does not self-resolve in seconds |
| `auth`           | **FAST_FAIL**                                  | 1                                                             | Long — usually a configuration error (wrong key), requires operator fix, retrying is pointless           |
| `rate_limit`     | **QUICK_RETRY**                                | 2 (original + 1 retry, fixed short delay, **no** exponential) | Short (`FAILOVER_COOLDOWN_SHORT_MS`, default 5 seconds) — burst rate-limit usually resolves very quickly |
| `server_error`   | **QUICK_RETRY**                                | 2                                                             | Short                                                                                                    |
| `unknown`        | **QUICK_RETRY**                                | 2                                                             | Short — safe default, error nature unclear so still give one chance before skipping                      |

Delay for `QUICK_RETRY` is a **small fixed constant** (default 150ms, not exponential backoff like the old `LlmAgentService.withRetry`) — the goal is catching transient errors within a few hundred ms, not "waiting to be sure" like the old retry approach (which was the main source of high latency users experience).

`isRetryableError()` on each child adapter **stays unchanged** (used by places that call a single adapter directly, not through Failover — the case with only 1 provider configured). In `FailoverLlmProviderAdapter`, the decision between quick-retry and fast-fail lives in `runFailover()`, based on `candidate.normalizeError(err).reason` — **not** dependent on `isRetryableError()` (because `isRetryableError()` only returns a boolean, not enough to distinguish "worth a quick retry" from "abandon immediately").

### 2. `OpenRouterAdapter` / `MiniMaxAdapter`

`packages/llm-agent/src/provider/openrouter/openrouter-adapter.ts`:

```ts
export class OpenRouterAdapter extends OpenAiAdapter {
  constructor(getApiKey, getModel, getBaseUrl) {
    super(
      getApiKey,
      getModel ?? (() => DEFAULT_OPENROUTER_MODEL),
      getBaseUrl ?? (() => 'https://openrouter.ai/api/v1'),
      'openrouter',
    );
  }
}
```

`packages/llm-agent/src/provider/minimax/minimax-adapter.ts` — same pattern, `providerName: 'minimax'`, default base URL points to MiniMax OpenAI-compatible endpoint.

Both inherit all `chatWithTools`/`chatStream`/`generateJson` logic from `OpenAiAdapter` (shared OpenAI SDK client pointing to different `baseURL`) — same pattern as existing `OpenAiCompatibleAdapter`, differing only in default model/baseURL/providerName.

### 3. `FailoverLlmProviderAdapter` — greedy pick + circuit breaker

**Provider selection algorithm**: greedy, follows the configured priority order (`order`), picks the **first healthy candidate** from the remaining set — exactly as required, nothing more complex than necessary (no load-balancing/weighted-routing needed because the goal is _correct and fast_, not even traffic distribution). What makes it **fast** is not the selection algorithm (already O(k) with k = number of providers, k is very small ~2-4), but the **in-memory circuit breaker** to avoid repeated network round-trips to a provider known to be down:

```ts
interface CircuitState {
  healthyAgainAt: number; // epoch ms — 0 means always healthy
}

export class FailoverLlmProviderAdapter implements LlmProviderAdapter {
  readonly providerName = 'failover';
  private readonly circuit = new Map<string, CircuitState>(); // key = provider.providerName

  constructor(
    private readonly candidates: LlmProviderAdapter[], // already filtered by isConfigured() from factory
    private readonly logger?: { warn: (msg: string) => void },
    private readonly clock: () => number = Date.now, // injectable for testing
  ) {}

  isConfigured(): boolean {
    return this.candidates.length > 0;
  }

  getDefaultModel(): string {
    return this.candidates[0].getDefaultModel();
  }

  async generateJson(request) {
    return this.runFailover((c, req) => c.generateJson(req), request);
  }
  async chatWithTools(request) {
    return this.runFailover((c, req) => c.chatWithTools(req), request);
  }
  chatStream(request) {
    // No failover mid-stream for a single stream (Non-goals) — but still respects circuit
    // breaker: skips candidates in cooldown, picks first healthy candidate.
    return this.pickHealthy()[0].chatStream(request);
  }

  isRetryableError(): boolean {
    return false; // already does internal failover/quick-retry — outer retry loop should not repeat.
  }
  isRateLimitError(error): boolean {
    return this.candidates[0].isRateLimitError(error);
  }
  normalizeError(error): LlmProviderError {
    return this.candidates[0].normalizeError(error);
  }

  /** Candidates not yet in cooldown, in original priority order. */
  private pickHealthy(): LlmProviderAdapter[] {
    const now = this.clock();
    const healthy = this.candidates.filter(
      (c) => (this.circuit.get(c.providerName)?.healthyAgainAt ?? 0) <= now,
    );
    return healthy.length > 0 ? healthy : this.candidates; // all in cooldown → still retry first candidate, better than throwing immediately
  }

  private async runFailover<Req, Res>(
    call: (c: LlmProviderAdapter, req: Req) => Promise<Res>,
    request: Req & { model?: string },
  ): Promise<Res> {
    const ordered = this.pickHealthy();
    let lastError: unknown;

    for (const candidate of ordered) {
      const req = { ...request, model: candidate.getDefaultModel() }; // model is not portable

      for (
        let attempt = 1;
        attempt <= this.maxAttemptsFor(candidate, lastError);
        attempt++
      ) {
        try {
          const result = await call(candidate, req);
          this.circuit.delete(candidate.providerName); // success → reset circuit
          return result;
        } catch (err) {
          lastError = err;
          const { reason } = candidate.normalizeError(err);
          const isFastFail = reason === 'quota_exceeded' || reason === 'auth';

          if (isFastFail || attempt === this.maxAttemptsFor(candidate, err)) {
            this.circuit.set(candidate.providerName, {
              healthyAgainAt:
                this.clock() +
                (isFastFail ? COOLDOWN_LONG_MS : COOLDOWN_SHORT_MS),
            });
            this.logger?.warn(
              `LLM_FAILOVER provider=${candidate.providerName} reason=${reason} attempt=${attempt} — moving to next candidate`,
            );
            break; // abandon this provider, move to next candidate in outer loop
          }

          // QUICK_RETRY: fixed short delay, no exponential.
          await sleep(QUICK_RETRY_DELAY_MS);
        }
      }
    }

    throw new LlmAllProvidersExhaustedError(
      ordered.map((c) => c.providerName),
      lastError,
    );
  }

  /** rate_limit/server_error/unknown = QUICK_RETRY (2 attempts); quota_exceeded/auth = 1 attempt (fast-fail). */
  private maxAttemptsFor(
    candidate: LlmProviderAdapter,
    lastError: unknown,
  ): number {
    if (!lastError) return 2; // reason unknown (first attempt) → allow max quick-retry
    const { reason } = candidate.normalizeError(lastError);
    return reason === 'quota_exceeded' || reason === 'auth' ? 1 : 2;
  }
}
```

**Why this is "optimal" for lowest latency, not just speculation**:

1. **No network round-trip to a known-dead provider** — the `circuit` map is in-memory, lives for the process lifetime (NestJS singleton). After the first fast-fail of a provider (out of credits/wrong key), all _subsequent_ chat turns within `COOLDOWN_LONG_MS` (10 minutes) skip it entirely at the `pickHealthy()` step — O(1) timestamp comparison, no HTTP call. This is the most important part for real-world latency during extended outages (e.g. out of credits all day) — not just optimizing a single call.
2. **Quick-retry has a hard time cap** (fixed 150ms × max 1 retry) instead of exponential backoff (old: could reach seconds/tens of seconds) — catches transient errors without accumulating high latency.
3. **Fast-fail skips quick-retry entirely** for errors known to not self-resolve (quota/auth) — matching the requirement "out of credits, no retry needed, fallback early".
4. **Greedy in configured priority order** (no round-robin/random) — matching the intent "pick the first healthy one from the secondary set", and easier to predict/debug than complex load-balancing algorithms this feature does not need.

`COOLDOWN_LONG_MS` (10 minutes), `COOLDOWN_SHORT_MS` (5 seconds), `QUICK_RETRY_DELAY_MS` (150ms) read from config with defaults — following the existing retry constants pattern in `LlmExecutionConfigService`.

**Model is not portable**: each provider has its own model id (`gpt-5.4` does not exist on OpenRouter/MiniMax). `runFailover` always overrides `request.model` with `candidate.getDefaultModel()` before calling — callers (agent loop, report service...) do not need to know which model is actually running, only read `response.metadata.provider` + `response.metadata.model` after receiving the response (this field already exists, no schema change needed).

**`isRetryableError() = false`** is the key design point making the 3 existing retry layers (`LlmAgentService.withRetry`, `LlmExecutionService.runWithRetry`, `DiscordAgentService.runWithRetry`) **stop immediately** when `FailoverLlmProviderAdapter` throws `LlmAllProvidersExhaustedError` — no pointless repetition of the entire failover+quick-retry chain at the upper layer.

### 8. Adding new providers later — no core logic changes

Adding 1 new provider (Anthropic, Gemini, DeepSeek standalone, etc.) only requires:

1. Create a new adapter class implementing (or extending `OpenAiAdapter` if the API is OpenAI-compatible) `LlmProviderAdapter`, most importantly `normalizeError()` returns the correct `reason` from the 5 existing enum values (`rate_limit` / `server_error` / `auth` / `quota_exceeded` / `unknown`) based on that provider's specific error shape.
2. Add 1 new `case` in `createLlmProviderAdapter()` (factory switch).
3. Add new config entry (API key/model/baseURL getters) + add provider name to `LLM_PROVIDER_FAILOVER_ORDER` when you want to enable it.

**No changes to** `FailoverLlmProviderAdapter` — all circuit-breaker/quick-retry/fast-fail logic works purely based on the `LlmProviderAdapter` interface + shared `reason` enum, unaware and not needing to know the specific provider. This is precisely why `normalizeError()` must return a normalized `reason` instead of having the failover logic parse each provider's specific error shape.

### 4. Factory

`packages/llm-agent/src/provider/factory.ts`:

```ts
export interface LlmProviderEntryConfig {
  provider: string; // 'openai' | 'openai-compatible' | 'openrouter' | 'minimax'
  getApiKey: () => string | undefined;
  getModel: () => string;
  getBaseUrl?: () => string | undefined;
}

export function createLlmProviderAdapter(config: LlmProviderEntryConfig): LlmProviderAdapter {
  switch (config.provider) {
    case 'openai': return new OpenAiAdapter(...);
    case 'openai-compatible': return new OpenAiCompatibleAdapter(...);
    case 'openrouter': return new OpenRouterAdapter(...);
    case 'minimax': return new MiniMaxAdapter(...);
    default: return new OpenAiAdapter(..., config.provider); // keep old fallback
  }
}

/**
 * Build failover chain in `order` sequence. Providers not configured (missing API key)
 * are filtered out of the candidate list here — no need to wait for runtime.
 * If only 0-1 providers are configured → return that adapter directly (no Failover wrapper),
 * preserving current behavior/latency for the most common case.
 */
export function createFailoverLlmProviderAdapter(
  entries: LlmProviderEntryConfig[],
  order: string[],
  logger?: { warn: (msg: string) => void },
): LlmProviderAdapter {
  const byProvider = new Map(entries.map((e) => [e.provider, e]));
  const orderedAdapters = order
    .map((name) => byProvider.get(name))
    .filter((e): e is LlmProviderEntryConfig => !!e)
    .map((e) => createLlmProviderAdapter(e))
    .filter((a) => a.isConfigured());

  if (orderedAdapters.length === 0) {
    throw new Error('No LLM provider configured in failover order');
  }
  if (orderedAdapters.length === 1) {
    return orderedAdapters[0];
  }
  return new FailoverLlmProviderAdapter(orderedAdapters, logger);
}
```

### 5. Config (new env vars)

| Var                                 | App  | Notes                                                                                                    |
| ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER_FAILOVER_ORDER`       | both | CSV, e.g. `openai,openrouter,minimax`. Empty/absent → old behavior (`LLM_PROVIDER` single, no failover). |
| `OPENROUTER_API_KEY`                | both |                                                                                                          |
| `OPENROUTER_MODEL`                  | both | default TBD — see Open Questions                                                                         |
| `OPENROUTER_BASE_URL`               | both | default `https://openrouter.ai/api/v1`                                                                   |
| `MINIMAX_API_KEY`                   | both |                                                                                                          |
| `MINIMAX_MODEL`                     | both | default TBD                                                                                              |
| `MINIMAX_BASE_URL`                  | both | default TBD — verify actual MiniMax OpenAI-compatible endpoint                                           |
| `LLM_FAILOVER_COOLDOWN_LONG_MS`     | both | default 600_000 (10 minutes) — cooldown after fast-fail errors (quota/auth)                              |
| `LLM_FAILOVER_COOLDOWN_SHORT_MS`    | both | default 5_000 — cooldown after transient errors (rate_limit/server_error/unknown)                        |
| `LLM_FAILOVER_QUICK_RETRY_DELAY_MS` | both | default 150 — fixed delay between 2 retries on the same provider before failover                         |

`LlmExecutionConfigService` (messenger-bot) adds corresponding getters following the existing pattern (`getApiKey()`, `getModel()`, `getBaseUrl()` currently) — no hardcoded default numbers/tokens, per `project-conventions.md`.

### 6. Wiring

- `apps/messenger-bot/.../llm-execution.module.ts`: change `useFactory` from calling `createLlmProviderAdapter(...)` (single) to `createFailoverLlmProviderAdapter(entries, order, logger)`, `entries` built from `LlmExecutionConfigService` (openai + openrouter + minimax). When `getFailoverOrder()` is empty → use exact old behavior (`[config.getProvider() ?? 'openai']`) to **not change default behavior** for current deployments that have not set the new variables.
- `apps/discord-bot/.../discord-chat.module.ts`: **bug fix** — remove hardcoded `new OpenAiAdapter(...)`, use same `createFailoverLlmProviderAdapter` reading directly from `ConfigService` (discord-bot has no dedicated LLM config service — inline in factory function, keeping the current file pattern, no unnecessary abstraction for 1 module).

### 7. Naming/logging for easier debugging

When failover occurs, log `LLM_FAILOVER provider=<X> failed, trying next` (already in the pseudo-code above) — combined with existing `response.metadata.provider` in `LlmUsageRecorder`, sufficient to know which provider actually responded to each chat turn without adding new DB tables/columns.

## Historical Open Questions (resolved or changed in the implementation)

1. **MiniMax base URL + exact error shape**: Current wiring is env-driven through `MINIMAX_BASE_URL` (the shared example uses `https://api.minimax.chat/v1`) and `MINIMAX_MODEL` falls back to `MiniMax-Text-01`; provider-specific normalization is handled by the shared OpenAI-compatible adapter.
2. **OpenRouter default model id**: Current wiring defaults `OPENROUTER_MODEL` to `openai/gpt-4o-mini`; `OPENROUTER_BASE_URL` is env-driven and the shared example uses `https://openrouter.ai/api/v1`.
3. Retry policy: the implementation uses one quick retry for transient `rate_limit`/`server_error`/`unknown` errors before failover, while `quota_exceeded`/`auth` fast-fail. This supersedes the proposal's earlier "always failover immediately" option.

**Current implementation map:** `packages/llm-agent/src/provider/factory.ts`, `packages/llm-agent/src/provider/from-env.factory.ts`, and `packages/llm-agent/src/provider/failover/failover-adapter.ts`; app bindings are `apps/messenger-bot/src/modules/llm-execution/llm-execution.module.ts`, `apps/discord-bot/src/modules/discord-chat/discord-shared.module.ts`, and `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts`. The historical file list below is retained as the original design breakdown.

## Files Changed

| File                                                                                                | Change                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/llm-agent/src/provider/types.ts`                                                          | Add `'quota_exceeded'` to `LlmProviderError['reason']`                                                           |
| `packages/llm-agent/src/provider/openai/openai-adapter.ts`                                          | `normalizeError()`/`isServerError()` detect status 402 + out-of-credits marker text → `reason: 'quota_exceeded'` |
| `packages/llm-agent/src/provider/openrouter/openrouter-adapter.ts`                                  | **New** — `OpenRouterAdapter extends OpenAiAdapter`                                                              |
| `packages/llm-agent/src/provider/minimax/minimax-adapter.ts`                                        | **New** — `MiniMaxAdapter extends OpenAiAdapter`                                                                 |
| `packages/llm-agent/src/provider/failover/failover-adapter.ts`                                      | **New** — `FailoverLlmProviderAdapter`                                                                           |
| `packages/llm-agent/src/provider/failover/failover.errors.ts`                                       | **New** — `LlmAllProvidersExhaustedError`                                                                        |
| `packages/llm-agent/src/provider/factory.ts`                                                        | Add `openrouter`/`minimax` cases, add `createFailoverLlmProviderAdapter()`                                       |
| `packages/llm-agent/src/index.ts`                                                                   | Export new adapter/factory/error                                                                                 |
| `apps/messenger-bot/src/modules/llm-execution/application/services/llm-execution-config.service.ts` | Add OpenRouter/MiniMax getters + `getFailoverOrder()`                                                            |
| `apps/messenger-bot/src/modules/llm-execution/llm-execution.module.ts`                              | Use `createFailoverLlmProviderAdapter`                                                                           |
| `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts`                                  | **Bug fix** — remove hardcoded `OpenAiAdapter`, use `createFailoverLlmProviderAdapter`                           |
| `apps/messenger-bot/.env.example` (if exists)                                                       | Add new variables                                                                                                |
| `apps/discord-bot/.env.example` (if exists)                                                         | Add new variables                                                                                                |
| `docs/adr/0006-llm-provider-adapter.md`                                                             | Mark Phase 4 (Minimax adapter + multi-provider routing) → done, link to this spec                                |

Detailed task/commit breakdown: see [tasks.md](./tasks.md).
