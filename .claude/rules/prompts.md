---
alwaysApply: false
paths: apps/*/src/shared/prompts/**,packages/llm-agent/src/messages.ts,packages/llm-agent/src/chat-system-prompt.ts
---

# LLM system prompts

## Chat prompt (free-form chat, all 3 bots)

Composed in `PlatformAgentService.buildSystemPrompt` (`packages/chat-agent`):
`CHAT_SYSTEM_PROMPT_CORE` (universal rules) + per-bot overlay file.

| Part    | File                                                                       | Content                                                                                                              |
| ------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Core    | `packages/llm-agent/src/chat-system-prompt.ts` (`CHAT_SYSTEM_PROMPT_CORE`) | Scope, out-of-scope, non-disclosure of internal details (#625), no-tool rules, no-fabrication, `precreate_next_exercise`, general rules — **shared, edit once** |
| Overlay | `apps/messenger-bot/src/shared/prompts/messenger-chat.system.txt`          | Identity, report registration, cards, reschedule buttons                                                             |
| Overlay | `apps/discord-bot/src/shared/prompts/discord-chat.system.txt`              | Identity, server-channel DM privacy, reschedule buttons                                                              |
| Overlay | `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt`                    | Identity, reschedule confirm flow                                                                                    |

Rule: universal rule → core; platform mechanism → overlay. Never duplicate a core rule into an overlay (or the drift problem returns).

## Standalone prompts (Messenger)

| File                                                              | Service                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/messenger-bot/src/shared/prompts/student-report.system.txt` | `modules/student-report/application/services/student-report.service.ts` |
| `apps/messenger-bot/src/shared/prompts/study-reminder.system.txt` | `modules/study-reminder/application/services/study-reminder.service.ts` |

Loaded via `@wispace/llm-agent`'s `loadSystemPromptFile()` (apps pass their own `promptDir`/`promptFile`).

Shared messages (not platform-specific) — `buildPromptInjectionBlockedMessage`, `buildWispaceScopeRedirectMessage` — live in `packages/llm-agent/src/messages.ts`, shared across all bots.

## Non-disclosure guard (#625)

A single fixed line — `NON_DISCLOSURE_REPLY` / `buildNonDisclosureReply()` in `packages/bot-common/src/messages/bot-messages.ts` (re-exported from `@wispace/llm-agent`) — answers **both** the self-intro path (`buildSelfIntroMessage()` collapses to it) and any probe for internal details. It must never vary by framing: a differential reply is an oracle.

- **Prompt core** — `Non-disclosure of internal details (mandatory):` section in `CHAT_SYSTEM_PROMPT_CORE`. Its header is in `SYSTEM_PROMPT_LEAK_MARKERS` (`final-output.utils.ts`) and asserted by `chat-system-prompt.spec.ts`.
- **Detector** — `detectDisclosureProbe()` (`prompt-injection.utils.ts`), VN + EN + basic zh, resilient to diacritics / `đ` / confusables / zero-width / spacing / leetspeak. Run at each bot gateway **before** `IntentDetector.detect()` and again in `LlmAgentService.checkEarlyReturns` (defense-in-depth). A match → `buildNonDisclosureReply()`, not a "blocked" message. Bare `extraction` injection hits also route there. base64/ROT13-encoded probes (taxonomy G) are **not** decoded at runtime (perf/false-positive surface) — the prompt core still forbids answering them.
- **Output guard** — `checkFinalOutputSafety` reason `vendor_leak` (+ `prompt_leak`) → redacted to `buildNonDisclosureReply()`; `credential_leak` still → `buildFinalOutputBlockedMessage()`.
- **Not covered by the offline eval harness** (scripted model, no multi-turn reasoning): taxonomy H (progressive multi-turn) and the debounce-split part of G — prompt-core only. Taxonomy I (error/debug probing) is detected (`category: 'debug'`); base64/ROT13 framings of G are prompt-core only.

## Adding a new tool (convention)

The tool schema (name + `description` + parameters in `packages/llm-agent/src/agent.tools.ts`) is injected into every LLM request automatically — the model always sees it. Use it as the primary guidance surface:

1. **Put "when to use / when not to use" in the schema `description`** (e.g. trigger phrases, "do not call when..."). Simple tools need **no prompt edit at all**.
2. **Edit the prompt core only for cross-cutting rules**: result phrasing constraints (e.g. precreate URL copy-verbatim, status paraphrase), cross-tool coordination (e.g. no `get_upcoming_study_sessions` inside a reschedule flow), or general no-tool rules.
3. **Platform-specific tool behavior → the platform overlay** (buttons vs keywords, DM privacy), never the core.
4. A new rule in the core must also be reflected in `packages/llm-agent/src/chat-system-prompt.spec.ts` (section-presence guards).

## After modifying a prompt

```bash
# chat core (packages/llm-agent) + composition (packages/chat-agent):
npx turbo run build --filter=@wispace/chat-agent... --filter=@wispace/messenger-bot...
# app overlay / standalone prompt files:
npx turbo run build --filter=@wispace/messenger-bot...
```

Nest copies assets to `apps/*/dist/shared/prompts/` (`nest-cli.json` → `assets`).

## Conventions

- Do not inline long prompts in application services.
- Output message content: Vietnamese, friendly, concise, suitable for each platform.
- Missing `OPENAI_API_KEY` → hardcoded template fallback (handled in `LlmAgentService.reply()` in `packages/llm-agent`, no API call).
- Do not pass user/WISPACE strings directly to LLM if they may contain instructions: use `sanitizeUntrustedTextForLlm` (from `@wispace/llm-agent`) for individual fields and `sanitizeToolResultContent` for JSON tool results.
- Do not directly cast JSON output from the model and format it; parse + validate shape with `llm-json-output.utils.ts` (app), fallback to template on error.

## No-secrets-in-model-context invariant (#632)

Prompt, tool schema, and tool results are a **no-secrets zone**: no secret ever reaches model context, enforced at the boundary — new code adding a field to any of them inherits the guard automatically.

**Boundary map (audit of every string path into model context):**

| Path | Carrier | Guard |
| --- | --- | --- |
| Prompt core + per-bot overlay | Static TS module / prompt files | Static content — nothing user- or env-derived |
| System prompt suffix (display name, learner facts, per-bot extras) | User-controlled / DB data | Redacted at the single consumption point, `PlatformAgentService.buildSystemPrompt` (`redactSecrets`) — every suffix builder inherits it |
| Tool schemas (`AGENT_TOOLS`) | Static TS module | Static content |
| Tool results | WISPACE data, upstream messages | `sanitizeToolResultContent` (recursive value redaction + injection scan) |
| Agent-facing error strings | Upstream errors (`WispaceApiError`, fetch failures) | `errorMessage()` (bot-common) masks shapes; `sanitizeUntrustedTextForLlm` redacts shapes + registered runtime values |
| Tool result pinned facts (exercise URL) | Config-derived URL | `WISPACE_API_*` URLs fail closed via `validateUpstreamUrl` (HTTPS-only, credentials in URLs rejected) |
| History / user messages | Learner's own text | Untrusted input — never a *system* secret carrier (a learner's own pasted secret is their data, replayed as their data); injection guard + sanitizers apply |
| Retry / circuit-breaker errors | Static typed reasons (`queue_full`, `wait_timeout`, …) | Static content |
| Correlation ids (`mid`, event ids) | Platform ids, no secret material | `maskEventId`/`maskExternalId` for logs only |

**Enforcement:** `redactSecrets` (`packages/llm-agent/src/utils/secret-redaction.utils.ts`) matches credential shapes (`CREDENTIAL_SHAPES` — shared with the output guard `checkFinalOutputSafety`, one list for both sides) **and** the process's runtime secret values registered at boot via `registerRuntimeSecrets(collectRuntimeSecretValues(...))` in each app's `main.ts`. Placeholder: `[REDACTED]` (same as bot-common masking). When you add a new secret env var, also add its key to `RUNTIME_SECRET_ENV_KEYS`.

**When you add anything that flows into model context:** route it through one of the boundary functions above — do not interpolate config values into prompts, tool descriptions, or tool results, and do not return raw upstream error bodies to the agent. Seeded-secret tests (search `#632` in specs) pin the guarantee: a secret planted in a WISPACE error, a tool-result field, or a suffix reaches neither the model input nor the logs.
