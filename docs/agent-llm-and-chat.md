# Chat agent: prompts, tools, injected context, evals

Read when changing a system prompt, an agent tool, the chat wiring, or anything
the model sees. The model-facing rules live here; the model-context _secret_
boundary lives in [`agent-redaction.md`](agent-redaction.md), and the
platform-parameterised wiring rules live in
[`architecture-boundaries.md`](architecture-boundaries.md).

## Prompt composition — three parts, one composer

The free-form chat prompt is assembled by `composeChatSystemPrompt` (#646), the
single place part order, separator, and suffix handling live:

1. `CHAT_SYSTEM_PROMPT_CORE` — universal rules, in
   `packages/llm-agent/src/chat-system-prompt.ts`. A TS module because packages
   do not ship `.txt` assets.
2. A per-bot overlay, `apps/*/src/shared/prompts/*-chat.system.txt` —
   platform-specific rules only.
3. A data-only `Process marker: <value>` part, added by
   `PlatformAgentService.buildSystemPrompt` (`packages/chat-agent`).

Universal rules are edited **once**, in the core; platform behaviour goes in the
overlay. Core rules are not restated in overlays.

Editing any `apps/*/src/shared/prompts/*.system.txt` requires `npm run build` —
Nest copies assets to `dist/shared/prompts/`. The student-report prompt is
canonical at `packages/student-report/src/prompts/student-report.system.txt`;
each app build copies those exact bytes to its existing runtime location, so
build all three apps after changing it.

New core APIs (including `generatePromptCanary`) import through
`@wispace/llm-agent/core`. The bare package root is not a supported entrypoint
(ADR 0041): there is no root façade, so a root specifier does not resolve.

## Adding a tool (#206)

The schema in `packages/llm-agent/src/agent.tools.ts` — name, `description`,
parameters — is injected into every LLM request and is the **primary guidance
surface**. Trigger phrases and exclusions belong in the `description`, so a simple
tool needs no prompt edit at all.

1. Put "when to use / when not to use" in the schema `description`.
2. Touch `CHAT_SYSTEM_PROMPT_CORE` only for a cross-cutting rule (result
   phrasing, cross-tool coordination, general no-tool rules).
3. Platform-specific tool behaviour → the platform overlay.
4. A new core rule is reflected in `chat-system-prompt.spec.ts` section guards,
   and the eval fixtures' core hash is re-validated (below).

Full checklist: `.claude/rules/prompts.md`.

## Tools and ports

`PlatformAgentService` consumes `PlatformToolExecutorPort`
(`packages/chat-agent`). The shared `PlatformAgentToolsService` implements the
Discord/Zalo tool sets; Messenger owns its executor
(`MessengerAgentToolsService`) implementing the same port, wired via `useExisting`
— there is no `toolOverrides` conditional dispatcher.

WISPACE data access crosses narrow capability ports
(`packages/chat-agent/src/agent/wispace-capability.ports.ts`, #425):
`chat-agent` does not import `wispace-client` (CI check
`.github/scripts/check-chat-agent-wispace-imports.sh`). Discord/Zalo wire adapter
wrappers and bake their identity headers at the composition root.

`precreate_next_exercise` has no arguments: it POSTs an empty body to
`WISPACE_API_PRECREATE_EXERCISE_URL` with `X-Internal-Key` and the platform
identity header, times out at `WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000`,
has no automatic retry, requires a linked account, creates only the next roadmap
exercise, requires an HTTPS URL for created or existing exercises, and returns a
generic Vietnamese failure on API or network errors. Selection parameters
(`taskType`/`exerciseTopic`) are a separate extension when WISPACE exposes them.

**Intent gate (#163).** The create endpoint is called only when the learner's own
message — `PlatformAgentToolContext.userText`, injected by the agent loop —
passes `checkPrecreateIntent`: explicit request phrases, no injection patterns, no
selection words (taskType/exerciseTopic/topic/difficulty). Anything else returns
`intent_unclear` and the model re-asks.

## Chat wiring goes through one factory (#1127)

The three chat composition roots call `createPlatformChatProviders` in
`@wispace/chat-agent`. It provides the four tokens in its exported
`PLATFORM_CHAT_PROVIDER_TOKENS` — `PlatformChatHistoryService`,
`PlatformAgentService`, `RedisChatQueueWorkerService`, `LEARNER_PROFILE_STORE` —
and builds the learner-profile `onToolResult` recorder and prompt suffix itself.

- The factory is platform-uniform: it selects no implementation by platform.
  Everything one bot owns (tool executor, queue service, confirmation service,
  cleanup crons) stays in that bot's module.
- Ten agent options arrive as closures over app-resolved services through one
  required app-local token. Every key is present; `null` means "this bot has no
  such hook" — a decision, whereas a default or an omitted key is the drift the
  design exists to prevent.
- `bash .github/scripts/check-platform-chat-providers.sh` (CI
  `deploy-scripts-test`, with its own red-path test) fails the build when a chat
  module stops calling the factory or re-declares one of those tokens.
- Out of scope by design: the shared chat-queue service, which Messenger
  replaced with its own processor and enqueue pair, so it stays app-wired.
- Vocabulary: `GLOSSARY.md` → _Platform provider factory_.

Wiring specs read the binding Nest actually resolves with
`findEffectiveFactoryProvider`, so deleting an override fails the spec.

## What enters model context

**Learner profile (#207 item 3).** `@wispace/learner-profile` persists compact
per-learner facts — band target `target_score`, exam date `exam_date` — in the
shared `learner_profiles` table, written only from server-derived tool results
(`get_user_goals` is the v1 source; `extractFactsFromToolResult` whitelists fields
and validates types, never guesses). It is wired through
`PlatformAgentOptions.onToolResult` (fire-and-forget recorder,
`createLearnerProfileRecorder`) and `systemPromptSuffix`
(`createLearnerProfileSuffix`, `DEFAULT_LEARNER_PROFILE_TTL_MS=24h` — stale facts
are omitted, not injected). Messenger composes it with its display-name suffix;
Discord/Zalo inject it as their suffix. All three bots register
`LEARNER_PROFILE_STORE` (TypeORM store over `LearnerProfileEntity`). `weakAreas`
is deferred — no server-derived source exists yet.

**Pinned facts (#207 item 6).** `pinFactsToReply`
(`packages/chat-agent/src/agent/pinned-facts.ts`) deterministically appends
server-derived facts when the model omits them; tools push
`PlatformAgentToolContext.pinnedFacts` (for example the precreated exercise URL
via `buildExerciseUrlFact`). It replaces the old per-feature
`ensurePrecreatedExerciseUrl`.

**Greeting copy is shared (#145).** Greeting, self-intro and welcome templates
for all three bots live in `packages/bot-common/src/bot-messages.ts`:
`buildGreetingMessage` rotates `GREETING_VARIANTS`, `buildSelfIntroMessage`
rotates `SELF_INTRO_VARIANTS`, plus `buildLinkSuccessMessage` and
`FALLBACK_DISPLAY_NAME`. Intent-detection replies (greeting/self_intro) and the
Get Started / link / follow / join welcomes use these builders, so new copy is
added there rather than per bot. The canonical capability list stays in the chat
prompt, not in the greeting.

**Server-derived facts win.** The reminder always renders the server-derived
`scheduledTimeLabel` (a model-emitted time is logged, never displayed), and
student-report facts — streak, task statuses, dates, counts, bands — are
generated deterministically from source data; the LLM writes prose only
(`docs/project-overview.md` §7).

**Practice role false positives (#1047).** `detectPromptInjection` exempts a
benign role request only when the same current learner message explicitly frames
it as practice; `Assistant:` is exempted only inside the introduced transcript
body, and a quoted `you are now a student at this school` only in a correction
request. The message reaches the provider unchanged. Instruction overrides and
hostile markers stay blocked, and the strict scanner for history and tool results
is unchanged.

Stored injection and history replay (#629), in-run tool observations (#414/#1236)
and the capability/approval policy (#416) are in
`.claude/rules/prompts.md` and `docs/project-overview.md` §7.

## Eval harness

`packages/llm-agent` runs a deterministic **offline** orchestration regression
for `LlmAgentService` tool-call decisions (#207, #227). The LLM is a frozen
scripted adapter: it proves the loop honours a fixture's expectations, not live
model or tool-selection quality, and it never calls a provider.

```bash
npm run eval:chat --workspace=@wispace/llm-agent     # just the harness (npm run test covers it in CI)
npm run eval:guardrail --workspace=@wispace/llm-agent # all fixtures as one tiered check
npm run eval:rehash:check                            # expose stale prompt hashes (never writes)
npm run classifier:eval --workspace=@wispace/llm-agent
```

Fixtures live in `packages/llm-agent/fixtures/*.json`. Each declares input
(`coreHash` — sha256 of the LF-normalized `CHAT_SYSTEM_PROMPT_CORE` **value**,
`promptFiles` — path + sha256 per overlay prompt file, LF-normalized; optional
`history` / `systemPromptSuffix`), a per-round LLM script (tool calls with args
and tool results, optional `content` = the model's plan line on multi-intent
rounds, or a final text), and `expected` (tool order, `toolSummary`/`exhausted`,
`replyTextContains`/`replyTextNotContains` fabrication guard, `groundingWarnings`,
`injectionEvents`, `planRemainder`, `requestContracts`).
`multi-tool-calendar-then-exercise.json` is the plan-step baseline for #207
item 2: its plan `content` must survive into the next round's messages.

Assertions (#227 hardening): exact ordered tool sequence; the **actual
serialized** tool args handed to the executor compared with the scripted args
(key-order independent); unexpected tool attempts always fail; the scripted plan
fully consumed unless `expected.planRemainder` declares intentional leftovers
(call-cap, duplicate side effects); `requestContracts` assert the system-prompt
fragments, latest user message, tool definitions and `toolChoice` per round (or
every round when `round` is omitted); leak (`toolResultsNotContain`) and plan-line
checks run across **every** provider request (`ScriptedAdapter.allRequests`), not
just the last. Scripted args are still validated against the `AGENT_TOOLS`
schema; no-tool-on-greeting; grounding/fabrication guard; the adapter is never
called for injection early returns (#161 leak guard — raw tool-error text must
not reach the model context). Discord/Zalo overlay coverage comes from
`discord-overlay-user-goals.json` and `zalo-overlay-reschedule-confirm.json`.

### Prompt changes fail the eval

Fixtures pin the real prompts, so any prompt edit breaks the hash until the
behaviour is re-validated and the hash updated deliberately — there is no
auto-approve. In a behaviour PR: build `@wispace/llm-agent`, run
`npm run eval:rehash:check` to see which hashes are stale, then `npm run eval:chat`
to re-validate. After that PR is reviewed and merged, rebase main and open a
hash-only rehash PR; write-mode `npm run eval:rehash` belongs to that PR. The
review authority for a hash rewrite is in `CODING_STANDARDS.md`. The guardrail
workflow runs check mode and never writes fixtures.

### Guardrail battery (#635/#1029)

`npm run eval:guardrail --workspace=@wispace/llm-agent` runs **all** fixtures as
one tiered CI check (workflow `.github/workflows/guardrail-battery.yml`,
path-filtered to `packages/llm-agent/**`, `packages/chat-agent/src/agent/**`,
`apps/*/src/shared/prompts/**`). The tier is a fixture field: `tier: "adversarial"`
on the injection/disclosure probes (6 today), `tier: "must-allow"` on curated
legitimate controls and issue-derived false positives (43 today); an undeclared
tier defaults to `must-block`. Pass bar: must-block and must-allow each require
**100%**; adversarial tolerates a **10% bypass rate**
(`ADVERSARIAL_BYPASS_RATE_LIMIT` in `guardrail-battery.ts`). Corpus pass rates are
not production traffic false-positive rates. Output reports each tier's rate and
names every regressed fixture.

A new bypass is captured, then fixed, then promoted: add the bypass as an
`adversarial` fixture (CI goes red), land the fix (the fixture turns green and
the reported rate drops), then remove the `tier` field so it can never regress.
The fixture is the record, so a red fixture is fixed rather than deleted.

Non-disclosure guard (#625): `disclosure-*.json` (empty script →
`detectDisclosureProbe` deflects to the standard line before the LLM),
`disclosure-output-*.json` (scripted leaky model text → `checkFinalOutputSafety`
redacts), `control-are-you-ai.json` / `control-writing-scoring.json` (legitimate
asks still reach the LLM). Taxonomy H's semantic progressive reasoning is outside
the offline harness (scripted model, no multi-turn reasoning), while #1257's
bounded raw-part/history split cases and debounce-split regex cases are covered
by the joint-scan fixtures.

The exhaustion fixture also asserts the partial answer (#207 item 4): grounded
data labels (`buildExhaustionPartialAnswer` in `messages.ts`) replace the generic
failure text. Loop trimming (#207 item 5) drops the oldest assistant frames
together with their tool results — never an orphaned `tool` message — so the
newest tool data survives longest. Tool-call cap and dedupe fixtures (#162):
`tool-call-cap.json` (5 distinct calls → fail-closed `buildToolCallCapMessage`,
nothing executes, `planRemainder: 5`) and `duplicate-side-effect.json`
(identical `precreate_next_exercise` calls execute once, the result is broadcast to
both ids, `planRemainder: 1`). The privacy guard spec rejects real-looking IDs
(`eval-` prefix required; no 15+ digit runs in fixture content).

Core harness files: `src/eval/eval-harness.ts`, `eval-harness.spec.ts`
(auto-discovery), `eval-harness.negative.spec.ts` (harness self-checks),
`privacy-guard.spec.ts`.
