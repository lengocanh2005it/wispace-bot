# Tasks — Multi-LLM Provider Failover (OpenRouter + MiniMax)

Full design in [spec.md](./spec.md). Each task = 1 small commit, with accompanying tests (per `.claude/rules/project-conventions.md` — small diffs, correct layer).

> **Status note (2026-08-13):** Phases 1–4 and the automated verification items are implemented. The remaining unchecked 5.3 item is intentionally a manual test requiring live provider credentials. The implementation consolidates OpenRouter/MiniMax into provider-labelled `OpenAiAdapter` entries in `packages/llm-agent/src/provider/factory.ts` and shared env wiring in `packages/llm-agent/src/provider/from-env.factory.ts`; it does not contain the separate adapter files proposed by the historical task breakdown. Current Discord/Zalo wiring is in `discord-shared.module.ts`/`zalo-chat.module.ts`, while Messenger wiring remains in `llm-execution.module.ts`.

Before starting: resolve the 2 open questions in the spec (MiniMax base URL/error shape, OpenRouter model default) — if official docs cannot be verified yet, implement with clear placeholder values + `// TODO verify` comment and note in PR, do not guess critical data (auth/billing).

## Phase 1 — `packages/llm-agent` provider layer

- [x] **1.1** Add `'quota_exceeded'` to `LlmProviderError['reason']` union in `provider/types.ts`.
- [x] **1.2** `OpenAiAdapter.normalizeError()` + private `isQuotaExhaustedError()`: detect status `402`, or status `429`/`400` with message/body containing `insufficient_quota`/`insufficient credit`/`insufficient balance`/`billing` → return `{ reason: 'quota_exceeded', retryable: false }`. Test: `openai-adapter.spec.ts` (create new if none exists, or add to existing test file) — case 402, case 429+insufficient_quota, case 429 normal rate-limit (no behavior change for old cases).
- [x] **1.3** `provider/openrouter/openrouter-adapter.ts` — `OpenRouterAdapter extends OpenAiAdapter`, default `providerName: 'openrouter'`, default baseUrl `https://openrouter.ai/api/v1`. Test: `openrouter-adapter.spec.ts` — `isConfigured()` false when key missing, `providerName` correct, default model/baseUrl correct when no override passed.
- [x] **1.4** `provider/minimax/minimax-adapter.ts` — `MiniMaxAdapter extends OpenAiAdapter`, `providerName: 'minimax'`, default baseUrl (value verified during prep step). Test similar to 1.3.
- [x] **1.5** `provider/failover/failover.errors.ts` — `LlmAllProvidersExhaustedError extends Error` (attempts: provider name[], cause: unknown), export from `index.ts`.
- [x] **1.6** `provider/failover/failover-adapter.ts` — `FailoverLlmProviderAdapter` fully implements `LlmProviderAdapter` + circuit breaker + quick-retry policy (see pseudo-code spec §3). Test `failover-adapter.spec.ts` (using injectable `clock` for time-independent tests):
  - `generateJson`/`chatWithTools`: candidate 1 fails (any reason) → candidate 2 succeeds → return candidate 2 result, candidate 3 not called.
  - All candidates fail → throw `LlmAllProvidersExhaustedError` containing correct list of providers tried.
  - `isConfigured()` true when at least 1 candidate configured, false when none (factory filters beforehand, but adapter itself must still be safe if given empty array).
  - `isRetryableError()` always `false` (direct assertion — key behavior to prevent outer retry loop from repeating failover).
  - Model overridden correctly per `candidate.getDefaultModel()` on each attempt (mock 2 adapters with different models, assert request sent to each adapter uses its own model).
  - **FAST_FAIL (`quota_exceeded`/`auth`)**: candidate throws this error → called exactly **1 time** (no quick-retry), immediate failover to next candidate, and that candidate is placed on long cooldown (`healthyAgainAt` = now + `COOLDOWN_LONG_MS`).
  - **QUICK_RETRY (`rate_limit`/`server_error`/`unknown`)**: candidate throws this error on attempt 1, succeeds on attempt 2 → return success result, total 2 calls to that candidate with delay between calls = `QUICK_RETRY_DELAY_MS` (assert via fake timer, not real time measurement). If both attempts fail → failover to next candidate, short cooldown (`COOLDOWN_SHORT_MS`).
  - **Circuit breaker skip**: candidate is in cooldown (set `healthyAgainAt` in future via injected `clock`) → `pickHealthy()` removes that candidate from retry list, **no** `call()` made to it (assert via spy not being invoked) — proves no network round-trip wasted on known-dead provider.
  - Circuit breaker reset: candidate succeeds on a subsequent call → `circuit.delete()`, next turn that candidate is tried normally (not stuck in permanent cooldown before natural expiry).
  - All candidates in cooldown simultaneously → `pickHealthy()` falls back to full `candidates` list (retry first candidate) instead of throwing immediately without trying — avoids false outage if cooldown estimation is wrong.
  - `chatStream`: current implementation attempts the next healthy candidate if stream iteration throws; already-emitted events cannot be withdrawn. Circuit-breaker selection and stream fallback are covered in the current failover adapter tests.
- [x] **1.7** `provider/factory.ts` — add provider entries for `openrouter`/`minimax` and `createFailoverLlmProviderAdapter(entries, order, logger?)`. Test `factory.spec.ts`:
  - `order` empty/1 provider configured → return single adapter directly (no `FailoverLlmProviderAdapter` wrapper) — assert via `instanceof`.
  - `order` ≥2 providers configured → return `FailoverLlmProviderAdapter` with correct order.
  - Provider in `order` but missing key (`isConfigured()===false`) → filtered out of candidate list.
  - `order` all unconfigured providers → throw clear error.
- [x] **1.8** `packages/llm-agent/src/index.ts` — export `OpenRouterAdapter`, `MiniMaxAdapter`, `FailoverLlmProviderAdapter`, `LlmAllProvidersExhaustedError`, `createFailoverLlmProviderAdapter`, `LlmProviderEntryConfig`.
- [x] **1.9** Run `npx turbo run build test --filter=@wispace/llm-agent` — green before moving to Phase 2.

## Phase 2 — `apps/messenger-bot` wiring

- [x] **2.1** `llm-execution-config.service.ts` — add getters: `getFailoverOrder(): string[]` (parse CSV from `LLM_PROVIDER_FAILOVER_ORDER`, empty if unset), `getOpenRouterApiKey/Model/BaseUrl()`, `getMiniMaxApiKey/Model/BaseUrl()`, `getFailoverCooldownLongMs/ShortMs()`, `getFailoverQuickRetryDelayMs()` — following existing getter pattern (default fallback, no throw). Add tests to current service spec (if no spec file exists, create one following other services' patterns in the module).
- [x] **2.2** `llm-execution.module.ts` — change `useFactory` to build `entries: LlmProviderEntryConfig[]` (openai + openrouter + minimax, each entry read from config service) then call `createFailoverLlmProviderAdapter(entries, config.getFailoverOrder(), logger)`. When `getFailoverOrder()` is empty → use exact old behavior (`[config.getProvider() ?? 'openai']`) to **not change default behavior** for current deployments without new variables set.
- [x] **2.3** Update `.env.example` (if exists in `apps/messenger-bot`) with new variables + brief comments.
- [x] **2.4** `npx turbo run build test --filter=@wispace/messenger-bot...` green.

## Phase 3 — `apps/discord-bot` wiring (with bug fix)

- [x] **3.1** `discord-chat.module.ts` — remove hardcoded `new OpenAiAdapter(...)` in `useFactory`. Build `entries`/`order` similar to Phase 2 but read directly from `ConfigService` (discord-bot has no dedicated LLM config service — inline in factory function, keeping current file pattern, no unnecessary abstraction for 1 module).
- [x] **3.2** Regression test: confirm when only `OPENAI_API_KEY` is set (no `LLM_PROVIDER_FAILOVER_ORDER`), Discord bot still uses single OpenAI exactly as before the fix — this test is important because this is a bug fix, must not change default behavior of current deployment.
- [x] **3.3** Update discord-bot `.env.example` with new variables.
- [x] **3.4** `npx turbo run build test --filter=@wispace/discord-bot...` green.

## Phase 4 — Docs

- [x] **4.1** `docs/adr/0006-llm-provider-adapter.md` — mark Phase 4 (Minimax adapter + multi-provider routing) as implemented, add link to this spec.
- [x] **4.2** If there is a doc listing full env vars (`apps/messenger-bot/docs/project-overview.md` or similar) — add new variables section, per "When changing code" checklist in `CLAUDE.md` (update agent documentation when API/env changes).

## Phase 5 — Full repo verification

- [x] **5.1** `npx turbo run format`
- [x] **5.2** `npx turbo run verify` (format:check + lint + typecheck + test + build, full workspace)
- [ ] **5.3** Manual test via Discord/Messenger dev: set `LLM_PROVIDER_FAILOVER_ORDER=openai,openrouter` with `OPENAI_API_KEY` **intentionally wrong** (simulating out of credits — use a revoked key or rate-limited key) + valid `OPENROUTER_API_KEY` → confirm bot still responds (via OpenRouter) without waiting for long retry backoff like old logs (`LLM call failed after 4 attempts`). **Requires running bot + real keys — cannot be automated.**

## Implementation Notes

- Per `.claude/rules/clean-architecture.md`: after modifying `packages/llm-agent` you **must** rebuild+test both `apps/messenger-bot` and `apps/discord-bot` before considering Phase 1 "truly done" (dependency between package and app).
- Do not rename/reshape any existing public fields (`LlmResponse.metadata.provider` is already sufficient to track which provider responded — no new DB columns needed).
- `FailoverLlmProviderAdapter.isRetryableError() = false` is a core design decision (spec §3) — do not "fix it back to true for consistency" when it looks unfamiliar, it intentionally disables outer retry because internal failover is already handled.
