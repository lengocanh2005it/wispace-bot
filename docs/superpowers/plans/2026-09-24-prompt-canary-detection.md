# Prompt Canary Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a process-scoped prompt canary that blocks and alerts on one detected disclosure across Messenger, Discord, and Zalo.

**Architecture:** `PlatformAgentService` generates one 128-bit canary during construction and stores it for process lifetime. Shared prompt composition carries it as a required data-only `Process marker` part, while the existing core non-disclosure rule supplies behavior and `LlmAgentService` gives the marker precedence in final-output safety. Telemetry exposes only a bounded platform counter; Prometheus turns one increment into an immediate critical alert.

**Tech Stack:** TypeScript, NestJS, Node crypto, Jest, prom-client, Prometheus promtool.

## Global Constraints

- Generate exactly 128 random bits and encode them as 32 lowercase hexadecimal characters.
- Keep the canary in process memory only; add no environment variable, database field, or per-request generator.
- Fail startup when secure randomness cannot produce a valid canary.
- Reuse raw and canonical output candidates; add no semantic matcher.
- Canary precedence: canary, then existing final-output precedence.
- Return the exact existing `buildNonDisclosureReply()` response.
- Never write a database safety event for a canary hit.
- Never place the canary, raw reply, raw reply content, or unmasked external user ID in logs, persisted history, metric labels, or alert annotations. Masked external IDs may follow the existing logging policy; external IDs must not enter metrics, alerts, or events.
- Keep pinned-facts behavior and report/reminder generation unchanged.
- Run format, lint, typecheck, focused tests, full tests, build, evals, and alert-rule tests before the final commit.

---

### Task 1: Shared canary and output guard

**Files:**
- Modify: `packages/llm-agent/src/chat-system-prompt.ts`
- Modify: `packages/llm-agent/src/types.ts`
- Modify: `packages/llm-agent/src/utils/final-output.utils.ts`
- Modify: `packages/llm-agent/src/internal/safety-pipeline.ts`
- Modify: `packages/llm-agent/src/agent.service.ts`
- Test: `packages/llm-agent/src/chat-system-prompt.spec.ts`
- Test: `packages/llm-agent/src/utils/final-output.utils.spec.ts`
- Test: `packages/llm-agent/src/internal/safety-pipeline.spec.ts`
- Test: `packages/llm-agent/src/agent.service.spec.ts`

**Interfaces:**
- Produces: `generatePromptCanary(entropy?: (size: number) => Buffer): string`
- Produces: required `LlmAgentPromptParts.promptCanary: string`
- Produces: `checkPromptCanarySafety(text: string, promptCanary: string): FinalOutputSafetyResult`
- Produces: `SafetyEvaluationInput.promptCanary?: string`

- [x] Add failing generator/composer tests for deterministic 32-character lowercase hex, entropy failure, required canary part, suffix order, and retention during context-budget recomposition.
- [x] Run `npm test --workspace=@wispace/llm-agent -- --runInBand chat-system-prompt.spec.ts agent.service.spec.ts`; expect failures for missing generator and prompt part.
- [x] Add `generatePromptCanary`, require `promptCanary`, and append one data-only `Process marker` part through `composeChatSystemPrompt` without changing `CHAT_SYSTEM_PROMPT_CORE`.
- [x] Use a fixed test-only 32-hex marker in the eval harness; do not use OS entropy or rewrite fixture hashes.
- [x] Add failing guard tests for ordinary prose, separator/format variants, static-marker coexistence, canary precedence, and exact non-disclosure replacement.
- [x] Run focused final-output and safety-pipeline tests; expect missing `prompt_canary_hit` behavior.
- [x] Implement canary matching with `buildSafetyScanCandidates` plus compact alphanumeric comparison, then run canary check before grounding in `SafetyPipeline`.
- [x] Pass `input.systemPromptParts?.promptCanary` from `LlmAgentService` into `SafetyPipeline`; prove context trimming keeps the part and normal IELTS replies remain allowed.
- [x] Run all four focused specs and `npm run typecheck --workspace=@wispace/llm-agent`.

### Task 2: Runtime wiring, integration seam, and metrics

**Files:**
- Modify: `packages/chat-agent/src/agent/platform-agent.service.ts`
- Modify: `packages/chat-agent/src/agent/platform-agent.types.ts`
- Modify: `packages/llm-agent/src/ports.ts`
- Modify: `packages/bot-metrics/src/bot-metrics.service.ts`
- Modify: `apps/messenger-bot/src/modules/messenger/chat-pipeline.module.ts`
- Modify: `apps/discord-bot/src/modules/discord-chat/discord-chat.module.ts`
- Modify: `apps/zalo-bot/src/modules/zalo-chat/zalo-chat.module.ts`
- Test: `packages/chat-agent/src/agent/platform-agent.service.spec.ts`
- Test: `packages/chat-agent/src/agent/platform-agent.prompt-canary.spec.ts`
- Test: `packages/llm-agent/src/agent.service.spec.ts`
- Test: `packages/bot-metrics/src/bot-metrics.service.spec.ts`

**Interfaces:**
- Consumes: `generatePromptCanary()` and `LlmAgentPromptParts.promptCanary`
- Produces: `AgentMetricsPort.promptCanaryHitInc?(): void`
- Produces: `BotMetricsService.incLlmPromptCanaryHit(platform: string): void`
- Metric: `<prefix>_llm_prompt_canary_hit_total{platform}`

- [x] Add failing PlatformAgentService tests proving constructor generation, stable value across requests, rotation across service instances, startup failure, and inclusion for Messenger, Discord, and Zalo configurations.
- [x] Run `npm test --workspace=@wispace/chat-agent -- --runInBand platform-agent.service.spec.ts`; expect generation/composition failures.
- [x] Generate and store the canary in `PlatformAgentService` constructor, import the new API through `@wispace/llm-agent/core`, and add it to every composed prompt part set.
- [x] Add a real `PlatformAgentService` + fake-provider integration test across Messenger, Discord, and Zalo that extracts the runtime canary from provider messages, returns it in prose, and verifies exact non-disclosure output, no raw reply in history or logs, and no safety-event persistence.
- [x] Add failing AgentMetrics and BotMetrics tests for exactly one bounded `{platform}` increment with no canary, raw reply, or external ID label.
- [x] Add `promptCanaryHitInc`, call it best-effort only for `prompt_canary_hit`, register the counter, and wire all three app modules to their fixed platform label.
- [x] Run focused chat-agent, llm-agent, and bot-metrics tests plus their typechecks.

### Task 3: Immediate critical alert and documentation

**Files:**
- Modify: `deploy/monitoring/alert.rules.yml`
- Modify: `deploy/monitoring/tests/alert.rules.test.yml`
- Modify: `docs/monitoring-alerts.md`
- Modify: `CONTEXT.md`
- Add: `docs/adr/0040-prompt-canary-detection.md`

**Interfaces:**
- Consumes: `<prefix>_llm_prompt_canary_hit_total{platform}`
- Produces: `LlmPromptCanaryDetected` with `severity=critical`, no `for`, and labels `job`, `platform`

- [x] Add promtool test series for ordinary `0 -> 1` and first-sample `1 1` counter shapes, with expected immediate critical alerts containing only `job`, `platform`, and `severity` labels plus static annotations.
- [x] Run `bash deploy/monitoring/tests/test-alert-rules.sh`; expect missing alert failure.
- [x] Add `LlmPromptCanaryDetected` using `increase(...[5m]) > 0` with a `max_over_time(...[5m]) > 0` first-sample fallback, grouped by `job, platform`, with no delay and no dynamic annotation values.
- [x] Document metric, immediate response, privacy boundary, and existing critical routing in `docs/monitoring-alerts.md`.
- [x] Re-run promtool checks/tests and scan the diff to ensure canary, raw reply, or raw reply content never enters persisted or alerting paths; masked external IDs remain allowed only under the existing logging policy.

### Task 4: Verification, review, and commit

**Files:**
- Review all changed files from Tasks 1–3.

- [x] Run `npm run format:check`.
- [x] Run `npm run lint`.
- [x] Run `npm run typecheck`.
- [x] Run focused issue tests again, including `npm test --workspace=@wispace/llm-agent -- --runInBand` and `npm test --workspace=@wispace/chat-agent -- --runInBand`.
- [x] Run `npm run test` once for the full monorepo suite.
- [x] Run `npm run build`.
- [x] Run `npm run eval:chat --workspace=@wispace/llm-agent`, `npm run eval:rehash:check --workspace=@wispace/llm-agent`, and `npm run eval:guardrail --workspace=@wispace/llm-agent`.
- [x] Run `bash deploy/monitoring/tests/test-alert-rules.sh`.
- [x] Invoke `/code-review`, fix every valid finding, and repeat affected verification.
- [x] Inspect `git status`, `git diff`, and `git log --oneline -10`; stage only issue #1285 files.
- [x] Commit on `main` with a concise issue-referencing message; do not push.
