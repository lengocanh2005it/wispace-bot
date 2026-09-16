# WISPACE BOTS

NestJS Turborepo monorepo for IELTS student bots — AI reports, study reminders, and rate-limited AI chat across Messenger, Discord, and Zalo.

## Language

### Platform & Identity

**WISPACE**:
External IELTS Writing learning platform that the bots integrate with via HTTP API.
_Avoid_: backend, Wispace API (when referring to the product itself)

**PSID**:
Page-Scoped ID — identifier Facebook assigns to each Messenger user, unique per Page. Used as `externalUserId` on the Messenger platform.
_Avoid_: user ID, sender ID

**externalUserId**:
Platform-specific user identifier (`psid` for Messenger, Discord user ID, Zalo UID). Used in cross-platform packages.
_Avoid_: platform user ID, bot user ID

**userId**:
Internal numeric WISPACE identifier (integer). Obtained after token verification during account linking or from an active platform mapping.
_Avoid_: ambiguous "user ID" — always write "WISPACE userId"

**ref**:
Query parameter in `m.me` links. Contains an opaque, WISPACE-issued linking token; it does not contain the WISPACE `userId`. The Messenger bot sends it to `WISPACE_API_VERIFY_TOKEN_URL` for verification.
_Avoid_: reference

**m.me**:
Facebook's short link domain for Messenger. `m.me/{page}?ref={token}&topic=...&cadence=...` is how WISPACE initiates the account-linking flow.
_Avoid_: Messenger link

**platform**:
String discriminator on most entities and cross-package types (`'messenger'`, `'discord'`, `'zalo'`). Allows multi-bot shared database.
_Avoid_: channel, service

### Account Linking

**linking / link**:
The process of pairing a PSID (Messenger) with a WISPACE `userId`. Occurs when a user opens an `m.me` link, the bot verifies the opaque `ref` token with WISPACE, and the mapping is saved.
_Avoid_: registration, signup

**MessengerLinkContext**:
Verified context from an `m.me` link: `{ ref, topic, cadence, userId }`. `userId` comes from WISPACE verification, not from parsing `ref`.
_Avoid_: link params, ref context

**NotificationCadence**:
How often the user wants to receive notifications: `'DAILY'`, `'WEEKLY'`, or `'MONTHLY'`. Stored on the mapping.
_Avoid_: frequency (field name is `cadence`)

**topic**:
Notification topic (e.g. `'IELTS'`, `'IELTS Writing'`). Stored on the mapping.
_Avoid_: subject

**user_platform_mappings** (DB table):
Primary mapping table (entity: `UserPlatformMappingEntity`). Stores `user_id`, `external_user_id`, `platform`, `cadence`, `topic`, `status`.
_Avoid_: user_messenger_mappings (migrated to new name)

**ACTIVE / INACTIVE**:
Mapping status. Only `ACTIVE` mappings receive notifications and are synced.
_Avoid_: enabled/disabled

**token link / token-only link**:
Preferred linking mode (`MESSENGER_LINK_MODE=token`). User verifies via `WISPACE_API_VERIFY_TOKEN_URL` with body `{token, value, platform}`. Prevents relinking (L4 constraint).
_Avoid_: ref-only linking

**allowRelink**:
Ops-only flag that allows relinking a PSID to a different WISPACE userId. Webhook linking blocks this change by default.
_Avoid_: reassign, rebind

**ownership generation**:
Monotonic version of a platform mapping's ownership. Privacy cleanup is fenced to the generation it actually erased, so a retry cannot clear state belonging to a newer relink.
_Avoid_: mapping version when referring to ownership fencing

### Privacy & Erasure

**privacy erasure**:
An operation that removes learner-attributable local data and platform-owned state for an external identity after a privacy request. It is distinct from time-based retention cleanup.
_Avoid_: purge, best-effort delete

**cleanup outcome**:
The result of a privacy erasure: `complete` means every applicable state store was cleared; `incomplete` means the database erasure committed but one or more stores remain outstanding.
_Avoid_: deleted boolean, partial success

**privacy cleanup store**:
One platform-owned state surface in an erasure plan: `chat_history`, `chat_queue`, `clarification_state`, or `display_name_cache`. Store names describe the data boundary, not the adapter method that clears it.
_Avoid_: cleanup callback, cache bucket

**privacy cleanup job**:
A durable work item for retrying one outstanding state-store cleanup for one identity and ownership generation. It remains actionable until the store is cleared or the job is safely retired as stale.
_Avoid_: retention job, generic cleanup task

**stale cleanup job**:
A privacy cleanup job that can no longer safely act because the identity's ownership generation changed. It is retired without touching the newer owner's state.
_Avoid_: failed cleanup, expired request

**privacy conflict**:
A privacy mutation refused because its expected mapping no longer matches the current owner. It is not a cleanup outcome and does not create a cleanup job.
_Avoid_: incomplete erasure, retry failure

**applicable state store**:
A platform-owned store included in the privacy erasure plan for that bot. A store that does not exist on a platform is not applicable; a configured store without a cleanup adapter is a configuration failure.
_Avoid_: optional purge, cache-only store

### Study Reminder

**study_reminder_jobs** (DB table):
Outbox table for study reminder schedule. Entity: `StudyReminderJobEntity`. States: `pending` → `processing` → `sent` / `failed` / `cancelled`.
_Avoid_: reminder queue, notification jobs

**sessionKey**:
Unique key for a study session (from UserCalendar record). Used as the idempotency key when upserting jobs: `unique(platform, external_user_id, session_key)`.
_Avoid_: session ID (it is a composite key, not a DB primary key)

**remindAt**:
Timestamp when the reminder message is sent. Calculated as `scheduledAt - STUDY_REMINDER_MINUTES_BEFORE`.
_Avoid_: sendAt, notifyAt

**scheduledAt**:
Actual study session start time, from the UserCalendar API.
_Avoid_: eventTime, startTime

**sync**:
The process of reading UserCalendar from the Wispace API and upserting/cancelling jobs in `study_reminder_jobs`. Occurs: via API call, 30-minute cron, and at server startup.
_Avoid_: refresh, reload

**dispatch**:
The process of picking up `pending` jobs where `remind_at <= now` and sending reminder messages via LLM. Uses adaptive polling.
_Avoid_: send, deliver

**adaptive poll (S2)**:
Dispatch strategy: poll interval varies between 30s and 3.5 minutes depending on distance to the next reminder (`STUDY_REMINDER_POLL_*` env vars).
_Avoid_: cron dispatch (it is an adaptive loop, not a fixed cron)

**StudyReminderOperationsPort**:
The narrow capability boundary through which Messenger reads upcoming study sessions, generates reminder content, reads calendar entries, and requests a reschedule. It is a port, not the `StudyReminderService` itself.
_Avoid_: injecting `StudyReminderService` into Messenger application services

**StudyReminderSyncPort**:
The link-side-effect capability through which Messenger requests a per-user study-reminder sync. The sync owns its authoritative session lookup and returns no reminder implementation details to Messenger.
_Avoid_: passing Study Reminder callbacks or `getSessions` internals across the boundary

**horizon**:
Search scope for upcoming sessions during sync (`STUDY_REMINDER_SYNC_HORIZON_HOURS`, default 14 days).
_Avoid_: window, lookahead

**rollover**:
The process at 23:00 ICT each evening: cleans up `sent` jobs, then re-syncs the horizon for the next day.
_Avoid_: nightly sync (rollover includes cleanup before re-sync)

**minLeadMinutes**:
Minimum time before a session starts within which a reminder can still be sent. If `scheduledAt` is closer, the job is cancelled.
_Avoid_: ambiguous "lead time"

**UserCalendar** / **UserCalendarRecord**:
Wispace API resource representing a scheduled study session. Fields: `id`, `userId`, `eventDate`, `time`.
_Avoid_: calendar event

**NormalizedStudySession**:
Normalized representation of a study session: `{ sessionKey, scheduledAt, topic, durationMinutes }`. Created from UserCalendar records.
_Avoid_: CalendarEvent, SessionRecord

### Reschedule Confirmation

**staged reschedule**:
Pending request created after validating a learner's UserCalendar session and before the learner confirms. It is not a calendar mutation; at most one active proposal exists per platform-scoped external identity, and a newer proposal supersedes the older token.
_Avoid_: rescheduled session, completed reschedule

**calendar mutation**:
The committed WISPACE write that changes a UserCalendar session, currently the reschedule flow. Staging a proposal or showing a confirmation prompt is not a calendar mutation.
_Avoid_: calendar staging, calendar read

**calendar cache invalidation**:
Removal of cached UserCalendar reads after a committed calendar mutation so the next read observes the latest WISPACE state.
_Avoid_: calendar refresh, calendar sync

**confirmation boundary**:
Point at which the bot commits to delivering the reschedule confirmation prompt. Cancellation before this boundary removes only the matching staged reschedule; after it, an outbound attempt cannot be retracted.
_Avoid_: confirmation complete, send completion

**approval token**:
One-time opaque token shown with a staged reschedule and required for text approval. It binds approval to the offered proposal; a token-less, mismatched, or superseded confirmation is not consent. The same value is the internal staging nonce used to conditionally remove that proposal before the confirmation boundary.
_Avoid_: confirmation code, approval code

**stop request**:
An explicit learner request to stop. In free-form chat it clears clarification state and any staged reschedule, but it does not cancel reminders, privacy actions, or account linking.
_Avoid_: ambiguous cancel, undo

**reschedule cancellation**:
Disarming a staged reschedule before it is claimed for the calendar write. It cannot undo a calendar write that has already started.
_Avoid_: rollback, reverse

**internal staging abort**:
Abandoning a reschedule staging attempt because its caller or tool deadline no longer waits for the result. It is distinct from a learner's stop request: it does not produce a prompt or recovery message, never mutates the calendar, and may remove only the matching staged proposal before the confirmation boundary.
_Avoid_: stop request, user cancellation

**staged reschedule expiry**:
The end of the ten-minute validity window after which a staged reschedule cannot be confirmed. Expiry is reported on the next related interaction rather than through a background message.
_Avoid_: confirmation timeout

### Student Report

**StudentCapacityInput**:
Data sent to the LLM to generate a report. Includes `exam_date`, `target_band`, `task1_band`, `task2_band`, `total_essays_task1/2`, `days_until_exam`, etc.
_Avoid_: report input, report data

**StudentCapacityReport**:
Structured output from the LLM: `{ headline, streak, "tinh trang task 1", "tinh trang task 2" }`.
_Avoid_: AI report (that is the formatted message the user sees)

**band / targetScore**:
IELTS score (0–9 scale). `targetScore` is the target band. `task1_band` and `task2_band` are the current averages for Task 1 and Task 2.
_Avoid_: ambiguous "score" — always use "band" or "target band"

**Task 1 / Task 2**:
Sections of the IELTS Writing exam. Task 1 = chart description; Task 2 = essay. The system tracks scores and essay counts per task.
_Avoid_: task1/task2 in text without context

**TaskScoreAverageRecord**:
Wispace API response with average IELTS scoring criteria: `avgTaskAchievement`, `avgCoherenceCohesion`, `avgLexicalResource`, `avgGrammaticalRangeAccuracy`, plus `currentStreak`, `highestStreak`, `totalPracticeTimeMinutes`.
_Avoid_: score record

**streak**:
Number of consecutive days/weeks of practice. Part of the report.
_Avoid_: consecutive count

**examDate**:
User's scheduled IELTS exam date. Governs the report window (`WISPACE_REPORT_DAYS_BEFORE_EXAM_*`).
_Avoid_: test date

**report window / days before exam**:
Calendar window (`2-3 days before exam`) within which reports are automatically sent. Configured via `WISPACE_REPORT_DAYS_BEFORE_EXAM_MIN/MAX`.
_Avoid_: notification window

**report_send_jobs** (DB table):
Outbox for retrying report sends when the Wispace API returns 5xx errors. Entity: `ReportSendJobEntity`. Unique on `(platform, external_user_id, exam_date)`.
_Avoid_: report queue

**scheduled_report_claims** (DB table):
Claim table for multi-pod cron leader election on the 08:00 cron job. Entity: `ScheduledReportClaimEntity`.
_Avoid_: report lock, cron claim

**fallback report**:
Deterministic template report used when the LLM provider is unavailable or returns invalid JSON. Generated by `buildFallbackReport()`.
_Avoid_: default report

### Chat Rate Limiting & Quota

**FREE_FORM**:
Chat interaction type subject to rate limiting: user sends free-text → bot replies via LLM. This is the only bucket with a quota.
_Avoid_: free chat, open chat

**quota**:
Daily usage allowance for a user's FREE_FORM interactions. Tracked by `(platform, externalUserId, usageDate)`.
_Avoid_: limit (used for burst limit), allowance

**chat_daily_usage** (DB table):
Daily usage counter table. Entity: `ChatDailyUsageEntity`. One row per user per day with `free_form_count`.
_Avoid_: messenger_chat_daily_usage (old name)

**freeFormCount**:
Number of FREE_FORM interactions a user has consumed today. Atomically incremented on reserve.
_Avoid_: usage count, chat count

**reserve**:
Atomic operation: (1) check burst limit, (2) insert idempotency row with status `reserved`, (3) increment `freeFormCount`. Returns `ChatQuotaCheckResult`.
_Avoid_: allocate, claim

**refund**:
Reverses a reservation when the LLM call or Send API fails before the user receives the message. Changes idempotency status to `refunded` and decrements the counter.
_Avoid_: rollback, revert

**markCompleted**:
Changes idempotency status from `reserved` to `completed` after the message is sent successfully.
_Avoid_: finalize, commit

**chat_idempotency** (DB table):
Ensures each `message.mid` (or platform message ID) is counted only once. Entity: `ChatIdempotencyEntity`. States: `reserved`, `completed`, `refunded`.
_Avoid_: dedup table (webhook delivery deduplication is owned by the durable `webhook_inbound_events` inbox)

**idempotencyKey**:
Platform-specific message identifier (`message.mid` on Messenger, `message.id` on Discord) used for double-count prevention.
_Avoid_: message ID — use `idempotencyKey` in quota context

**burst**:
Short-term (per-minute) rate limit to prevent spam. Checked before daily quota. Configured via `CHAT_BURST_PER_MINUTE`.
_Avoid_: spike limit, throttle

**ChatQuotaCheckResult**:
Quota check result: `{ allowed, used, limit, remaining, reason?, usageDate, quotaReserved? }`.
_Avoid_: quota response

**ChatQuotaDenyReason**:
Quota denial reason: `'DAILY_LIMIT'`, `'BURST_LIMIT'`, `'NOT_LINKED'`, `'IDEMPOTENCY_CONFLICT'`.
_Avoid_: deny reason string

**stuck reserved**:
Idempotency row stuck in `reserved` status beyond TTL (default 10 minutes). Recovered by `recoverStuckReservedSlots()` (H2 hardening).
_Avoid_: stale reservation

**whitelist**:
External user ids exempt from rate limiting, in `CHAT_RATE_LIMIT_WHITELIST_PSIDS`. Used for QA/testing. The env var keeps its `_PSIDS` name on every platform for compatibility, but the values are whatever that platform's `externalUserId` is — Zalo user ids on Zalo, not PSIDs.
_Avoid_: allowlist

### Chat Queue & Debounce

**debounce**:
Mechanism that buffers a user's rapid messages and merges them into a batch before processing. Configured via `CHAT_DEBOUNCE_MS`.
_Avoid_: throttle, batch delay

**flush**:
Action that processes a debounced batch: merges text, invokes rate limit, calls LLM, sends reply. Occurs after the debounce window expires.
_Avoid_: process, drain

**ChatQueueBatch**:
Merged message batch for one user: `{ externalUserId, texts[], context?, idempotencyKey? }`.
_Avoid_: message batch — always use `ChatQueueBatch`

**DebounceChatQueue**:
Framework-agnostic per-user debounce/merge state machine (in `packages/chat-queue-core`). Owns buffering, coalescing, eviction. Memory-only.
_Avoid_: chat queue — class name is `DebounceChatQueue`

**pendingWhileProcessing**:
Messages that arrive while the queue is flushing a batch. They are buffered and flushed after the current batch completes.
_Avoid_: queued messages

### Clarification & Event Delivery

**clarification state**:
Short-lived per-learner state used while the bot waits for one bounded menu choice.
_Avoid_: chat session, menu cache

**consumed state**:
Clarification state after a choice has been accepted; it is a tombstone window for already-seen event identities, not a ban on the same text in a new message.
_Avoid_: completed state, locked menu

**event identity**:
Stable identifier of one inbound platform event, normally the platform message id carried as `correlationId`.
_Avoid_: message text, timestamp

**redelivery**:
Later delivery of the same inbound event, recognized by the same event identity.
_Avoid_: repeated question, duplicate text

**skipDelivery**:
Reply outcome meaning an already-attempted canned clarification must not be sent again.
_Avoid_: ignored message, dropped message

### Messenger-Specific

**postback**:
Messenger button message that sends a predefined payload to the webhook. Used for menu actions (e.g., "Xem tien do", "Dang ky bao cao").
_Avoid_: button action, click event

**persistent menu**:
Menu always displayed at the bottom of a Messenger conversation. Configured via `POST /messenger/profile/setup`.
_Avoid_: bot menu, main menu

**messaging window / 24h window**:
Meta rule: bots can only send `RESPONSE` messages within 24 hours of the user's last message. This is why reports use `register_exam_report_notifications` (to obtain `notification_messages_token` for proactive messages outside the 24h window).
_Avoid_: send window without specifying "24h"

**notification_messages_token**:
Token from the Messenger One-Time Notification API, allowing the bot to send proactive messages outside the 24h window. Used for exam reports.
_Avoid_: proactive token, NTS token

**message.mid**:
Meta's unique message identifier. Used as the idempotency key for quota reservation and webhook deduplication.
_Avoid_: message ID — use `message.mid` in Messenger context

**webhook**:
HTTP endpoint (`POST /webhook`) that receives events from the Meta Messenger Platform. Verified via `X-Hub-Signature-256`.
_Avoid_: callback, event receiver

**dead letter / webhook_dead_letters** (DB table):
Webhook events that failed processing are stored here for later replay. Entity: `WebhookDeadLetterEntity`. States: `pending`, `replayed`, `abandoned`.
_Avoid_: failed webhook, dead queue

**message_logs** (DB table):
Audit log of all sent/received messages. Entity: `MessageLogEntity`. Cleaned up by cron (default 90 days).
_Avoid_: messenger_message_logs (old name), message history (that is `CHAT_HISTORY_STORE`)

**MessageSenderPort**:
Cross-module port token (`MESSAGE_SENDER`) for sending messages. Implemented by `MessengerOutboundService`. Used by `StudyReminderModule` to avoid circular dependency.
_Avoid_: injecting `MessengerService` from another module — always use the port

**routeWebhookEvent**:
Pure function that classifies a webhook event into `WebhookAction[]`. Takes `(event, ctx?)`, returns a list of actions. No side effects, no async, no NestJS dependency. Located in `messenger-webhook.router.ts`.
_Avoid_: routeEvent, classifyEvent

**WebhookAction**:
Value describing the action to perform for a webhook event. Types: `link_user`, `enqueue_chat`, `send_text`, `register_report`, `send_report`, `send_reminder_preview`, `confirm_reschedule`, `cancel_reschedule`, `send_welcome`, `consent_command`, `ignore`.
_Avoid_: ambiguous action type

**RouterContext**:
Pre-resolved context before calling the router: `{ userId?, linkContext?, shouldEnforceRateLimit?, refVerification? }`. Everything async — mapping lookup, ref verification, duplicate checks — happens during pre-resolve, so the router itself stays pure and synchronous.
_Avoid_: routing context, event context

**RefVerification**:
Outcome of verifying an event-carried referral ref during pre-resolve: `status` is `'verified' | 'committed' | 'blocked' | 'failed' | 'handoff_failed'`, plus the resolved link context and intent generation. Computed once so a single-use token is never submitted twice.
_Avoid_: ref check, token result

### LLM

**LlmAgentService**:
Framework-agnostic function-calling orchestration loop (in `packages/llm-agent`). Manages tool rounds, history, grounding checks, prompt injection detection. Provider-neutral — it talks to an `LlmProviderAdapter`, never to a vendor SDK (ADR-0006).
_Avoid_: chat service, AI service, "the OpenAI loop"

**context budget**:
The one input-token ceiling for a provider request, covering the current learner turn, system prompt parts, tool schemas, conversation history, and loop-generated messages.
_Avoid_: output budget, quota

**fixed context**:
Provider input that is not replayed conversation history: the system prompt parts and tool schemas. Some fixed context is optional under pressure; the current turn and safety rules are not.
_Avoid_: system prompt (it is only one part of fixed context)

**drop order**:
The explicit removal order when the context budget is tight: learner-profile section first, reasoning instruction second, then oldest history entries. The current learner turn, core/overlay rules, identity/display-name block, and full tool schemas remain the minimum valid request; if that minimum does not fit, the agent uses its fallback.
_Avoid_: retention priority, implicit trimming

**learner-profile section**:
Fresh server-derived learner facts, such as target band and exam date, appended for personalization. It is distinct from the identity/display-name block; facts older than the freshness window are omitted, and this section is optional when the context budget is tight.
_Avoid_: profile history, model-written facts

**identity/display-name block**:
Dynamic prompt context that states whether the platform identity is linked and how the bot should address the learner. It is retained even when the optional learner-profile section is removed.
_Avoid_: learner profile, user prompt suffix

**tool round**:
One iteration of the LLM function-calling loop. The agent can invoke multiple tools per user message, up to `maxToolRounds` (default 6).
_Avoid_: iteration, loop count

**tool schema**:
The single zod schema per agent tool (ADR-0010). The provider-facing JSON Schema, the argument type, and runtime argument validation all derive from it — never hand-written separately. Capability metadata (effect/identity/authorization/confirmation/idempotency) sits alongside it, not inside it.
_Avoid_: tool definition JSON, hand-written schema, three representations

**tool spec**:
The platform-independent declaration of an agent tool: its name, description, tool schema, capability metadata, and derived-tool metadata. A tool spec describes what the tool is and how shared chat code classifies its result; it does not contain platform execution or dependency injection.
_Avoid_: executable tool, platform handler, registry entry when referring to the declaration itself

**external tool name**:
A tool-name string returned by an LLM/provider before the runtime tool-name guard accepts it. It is untrusted input and must not be treated as an `AgentToolName` until validation succeeds.
_Avoid_: `AgentToolName` for an unchecked string, tool identifier when the source is the provider

**derived tool metadata**:
Shared projections of tool-spec metadata used for observations, learner-facing labels, grounding claims, and write-budget classification. The projections are generated from the specs so a newly registered tool cannot silently omit one of these policies.
_Avoid_: satellite map, manually maintained tool map

**tool summary**:
A bounded history record of the tools consulted during one learner turn and compact outcomes that may help interpret a follow-up. It is advisory context only; current-turn tool data remains authoritative for personal learner facts.
_Avoid_: fresh result, cached answer

**result line**:
A deterministic, one-tool line in a tool summary that reports a small set of structured outcome facts without model-written paraphrase.
_Avoid_: prose summary, tool transcript

**identifier section**:
A separate bounded part of a tool summary for server-issued identifiers needed by a follow-up action, such as `exerciseUrl` or `calendarId`. It is agent context, not learner-facing prose.
_Avoid_: inline identifier, learner-provided ID

**fresh tool data**:
Structured data returned by a tool during the current learner turn. It is the authority for answering current progress, goal, schedule, and exercise questions.
_Avoid_: history snapshot, cached personal data

**tool-executor pipeline**:
The shared lifecycle that turns an external tool request into a policy-checked platform-handler invocation and applies platform result decoration. It owns ordering and fail-closed boundaries, but not platform ports or tool execution.
_Avoid_: dispatcher when referring to the full lifecycle, platform handler, tool spec

**normalized platform identity**:
A validated mapping from a platform external identity to a WISPACE learner identity that linked tool handlers can trust. The platform adapter owns lookup; the shared pipeline owns the validation boundary and missing-identity outcome.
_Avoid_: raw platform identity, user context, platform token

**result decoration**:
Platform-specific delivery additions attached to an otherwise valid tool result, such as Messenger quick replies. Decoration cannot choose a handler or change policy, identity, budget, or abort behavior.
_Avoid_: dispatch, tool side effect, platform policy

**feature**:
String tag for categorizing LLM calls: `'FREE_FORM_CHAT'`, `'STUDENT_REPORT'`, `'STUDY_REMINDER'`. Used for usage tracking and metrics.
_Avoid_: use case, purpose

**LLM provider**:
An external service and model endpoint that executes prompts for the bots. A provider is identified by its adapter name and may be one link in a failover chain.
_Avoid_: vendor, backend

**effective endpoint**:
The base URL that a configured LLM provider will actually use after applying an explicit or vendor-default endpoint. It is the endpoint that startup security checks evaluate.
_Avoid_: provider URL, API URL

**endpoint allowlist**:
The required set of exact hostnames permitted for LLM provider calls. Matching is case-insensitive and does not imply wildcard subdomains; this is distinct from the quota `whitelist`.
_Avoid_: allowlist (without "endpoint"), trusted URL list

**configured provider**:
An LLM provider named in the resolved primary/failover order and therefore eligible to receive a request. Environment variables for providers outside that order do not make them configured.
_Avoid_: enabled provider, available provider

**failover candidate**:
A configured provider that may receive a request after an earlier provider in the failover order fails. An invalid candidate prevents the provider chain from starting.
_Avoid_: fallback provider, backup vendor

**model allowlist**:
The exact set of approved provider/model pairs that configured providers may run. Every configured provider must name a listed pair; there is no implicit model fallback.
_Avoid_: approved models, model whitelist

**provider/model policy**:
The rules that map an LLM feature and data class to the provider/model pairs it may use. The policy chooses what is approved; startup validation enforces that the resolved configuration stays inside it.
_Avoid_: routing policy (when referring only to the approved set), model preference

**classifier model**:
The model used by the optional input-classifier tier to label a fresh learner message as safe or unsafe. It is a separate configured model from the main chat/report/reminder model.
_Avoid_: moderation model, guard model

**model override**:
A model value supplied for one LLM request instead of the adapter's configured default. It is still subject to the same provider/model policy before any provider call.
_Avoid_: per-request model, ad-hoc model

**correlationId**:
Identifier that pairs an LLM call with its triggering event; when available, it is the inbound event identity used by clarification replay handling. It is optional, and the system does not infer identity from message text when it is absent.
_Avoid_: trace ID, request ID

**prompt injection**:
Attack where malicious text tricks the LLM. Detected by `detectPromptInjection()` and blocked before the provider call. Carries a source — `user_input`, `tool_result` or `history` — because the payload does not have to come from the learner.
_Avoid_: injection attack — use "prompt injection"

**grounding check**:
Verification that the LLM response is actually grounded in tool results (no hallucination). Performed by `checkLlmGrounding()`. Logs a warning if suspicious.
_Avoid_: hallucination check

**sanitizeUntrustedTextForLlm**:
Utility function that strips/escapes potentially dangerous content from user or Wispace data before inserting it into prompts or tool results.
_Avoid_: escape, encode — use "sanitize"

*_system prompt / *.system.txt*_:
Instructions sent as the `system` message. Files live in each app's `src/shared/prompts/` and are copied to `dist/` at build time.
_Avoid_: prompt file, AI instructions — use "system prompt"

**prompt core / overlay**:
The free-form chat prompt is composed, not stored in one file: `CHAT_SYSTEM_PROMPT_CORE` (`packages/llm-agent/src/chat-system-prompt.ts`) holds every universal rule and is shared by all three bots; each bot's `<platform>-chat.system.txt` is the **overlay**, carrying only what is platform-specific. `composeChatSystemPrompt()` joins core → overlay → suffix. A rule stated in the core is never copied into an overlay (`prompt-overlay-dedup.spec.ts`). The core has a size budget asserted in `chat-system-prompt.spec.ts`.
_Avoid_: "the chat prompt file" — there is no single file

**posture**:
The action a chat turn resolves to — answer, tool call, scope redirect, acknowledge-then-step, refuse-then-offer, non-disclosure line, de-escalate, support handoff, clarify. A closed set with one precedence order; adding one amends ADR-0009. Prompt sections are written per posture, not per kind of learner message.
_Avoid_: branch, rule, category

**fallback reply**:
Canned response used when the LLM provider is unavailable (not configured, or every failover target failed). Not LLM-generated.
_Avoid_: default reply, error reply

### LLM Usage Tracking

**llm_usage_events** (DB table):
Records token usage for each LLM call. Entity: `LlmUsageEventEntity`. Fields: `feature`, `model`, `promptTokens`, `completionTokens`, `totalTokens`, `estimatedCostUsd`, `toolRound`.
_Avoid_: token log, usage log

**estimatedCostUsd**:
Estimated cost in USD for an LLM call, calculated from token counts and model pricing (`LLM_COST_USD_PER_1M_*`). Not the actual invoice amount.
_Avoid_: cost without "estimated"

**fleet**:
All instances of the bot application combined. "Fleet summary" = aggregated usage across all pods. Accessed via `GET /messenger/ops/llm-usage/fleet`.
_Avoid_: cluster, deployment

### LLM Safety

**llm_safety_events** (DB table):
Records safety-related events (grounding warnings, prompt injection blocks, classifier verdicts). Entity: `LlmSafetyEventEntity`. Learner text is never stored raw — only a redacted excerpt plus a hash.
_Avoid_: safety log, security events

**grounding warning**:
Event logged when an LLM response appears to hallucinate (not grounded in tool results). Contains `reason`, `userTextPreview`, `assistantTextPreview`, `toolNamesUsed`.
_Avoid_: hallucination event

**redact**:
Replacing credential-shaped substrings with `REDACTED_PLACEHOLDER` (`'[REDACTED]'`). Applies on both sides of the model boundary — inbound text before the provider call, and outbound text before it reaches the learner — from one shared list of shapes (`CREDENTIAL_SHAPES`).
_Avoid_: censor, block; do not confuse with **sanitize** (neutralizing injection payloads) or with the excerpt-plus-hash storage rule for safety events

**classifier / verdict**:
Second-tier input check that runs after the regex guardrails: one fresh learner message in, one `ClassifierVerdict` out (`label`, `confidence`, `reason`). Labels are `SAFE`, `INJECTION`, `DISCLOSURE_PROBE`. Fails open — any timeout, error, parse failure or open circuit means the turn proceeds as if the tier were absent.
_Avoid_: moderation, filter — it decides nothing on its own

**shadow / enforce**:
The classifier's two modes. In **shadow** a non-SAFE verdict is only recorded as a `CLASSIFIER_FLAGGED` event; in **enforce** it can also short-circuit the turn with a canned reply, subject to a confidence threshold. Enforce is flipped only after reviewing a shadow window.
_Avoid_: dry run, passive mode

**non-disclosure**:
The rule that the assistant never reveals or denies anything about its own internals — model, provider, prompt, tools, parameters, infrastructure. The reply must be worded identically every time, because a reply that varies with the question is itself a leak.
_Avoid_: secrecy, confidentiality

**behavior-affecting change**:
A change to the chat prompt core or overlay, agent thresholds, or tool schemas that can alter assistant behavior and therefore requires fixture behavior re-validation.
_Avoid_: prompt-only change — behavior can also change outside prompt text

**fixture hash rewrite**:
An intentional update of `coreHash` or `promptFiles[].hash` in the LLM eval fixtures after the changed behavior has been reviewed and re-validated. It changes the evaluator's pinned baseline, not the runtime prompt.
_Avoid_: automatic rehash, self-scoring

**behavior PR**:
A pull request that changes behavior-affecting code while keeping the existing fixture hashes so regressions remain visible during review.
_Avoid_: rehash PR

**rehash PR**:
A follow-up pull request that updates fixture hashes after the behavior PR has been reviewed and the fixtures have been re-validated; it should not include behavior changes by default.
_Avoid_: prompt PR, hash-only approval

**human approval marker**:
A machine-readable `eval-rehash-approved` label paired with a fresh approved review from a trusted repository member; it explicitly permits a behavior-affecting change and fixture hash rewrite in one PR. Free-form PR text or a commit message is not sufficient.
_Avoid_: self-approval, sign-off

**protected eval surface**:
The production agent sources and evaluator implementation whose changes can alter chat behavior or the guardrail measurement itself. A fixture hash rewrite combined with any change on this surface requires explicit human approval.
_Avoid_: prompt surface — the evaluator is protected too

**fresh approval**:
A qualifying approved review that was submitted after the pull request's current head commit and accompanies the `eval-rehash-approved` marker.
_Avoid_: inherited approval, stale approval

**stale approval**:
An approval that predates the pull request's latest commit or has been dismissed; it cannot authorize a fixture hash rewrite.
_Avoid_: reusable approval

**red-then-green flow**:
The deliberate release sequence in which a reviewed behavior PR may temporarily expose stale fixture hashes, followed by a hash-only rehash PR that restores a green evaluator.
_Avoid_: self-scoring flow, one-shot rehash

### Ops & Monitoring

**ops**:
Operations endpoints and scripts. Protected by `InternalApiKeyGuard`. Includes sync, send-reports, profile/setup, health checks, quota status.
_Avoid_: admin, management

**INTERNAL_API_KEY**:
Shared secret for authenticating ops HTTP endpoints. Sent via header `X-Internal-Api-Key` or `Authorization: Bearer`.
_Avoid_: admin key, service key

**H1-H7**:
Chat rate limiting hardening items. H1=enable enforcement, H2=recover stuck, H3=hard cap in transaction, H4=send semantics, H5=abuse caps, H6=retention/logs, H7=shared queue.
_Avoid_: hardening phase — these are specifically numbered items

**R0-R5**:
Redis integration phases. R0=basic connection, R1=chat history, R2=webhook dedupe, R3=burst counter, R4=chat queue, R5=user display cache.
_Avoid_: generic redis phase

### Redis Availability

**Redis operation deadline**:
Maximum time the bot waits for a Redis command or connection attempt before treating Redis as unavailable. It is a failure boundary, not a retry instruction.
_Avoid_: Redis wait limit

**unknown Redis outcome**:
The client deadline or a connection loss prevents the caller from knowing whether Redis applied a command. Callers must use their own idempotency or fencing policy instead of blindly retrying the command.
_Avoid_: failed Redis write — the command may already have taken effect

### Database & Entities

**ai_chat_bot_db**:
Dedicated PostgreSQL database for the bot. Previously named `writing_ai_hub_db`.
_Avoid_: bot database, main DB

**"Users"** (view):
Read-only source of learner display name, target score and exam date on `ai_chat_bot_db`. Entity: `UserEntity`, mapped to the quoted `Users` view with PascalCase columns (`Id`, `TargetScore`, `ExamDate`, `DisplayName`, `Username`) — it is not a snake_case table like the rest of the schema. Lives in `apps/messenger-bot`, not in `packages/database`.
_Avoid_: user table, `users`

**DisplayName**:
User display name from the `"Users"` view. Falls back to `FALLBACK_DISPLAY_NAME` (`'Chào bạn nha'`, in `packages/bot-common`) when null. Used in LLM prompts for personalization.
_Avoid_: name, fullName

**chat_quota_events** (DB table):
Event-sourcing table for quota state changes. Entity: `ChatQuotaEventEntity`. Events: `CHAT_QUOTA_RESERVED`, `CHAT_QUOTA_RELEASED`, `CHAT_QUOTA_DENIED`.
_Avoid_: quota log, quota audit

**claim table**:
Abbreviation for `scheduled_report_claims` — used in the leader election pattern.
_Avoid_: lock table

**advisory lock**:
PostgreSQL advisory lock used with the claim table for cron leader election.
_Avoid_: database lock — specifically advisory lock

### Wispace API

**roadmap**:
WISPACE's ordered learning path for a learner. WISPACE is the source of truth for which exercise is next and whether the roadmap is complete.
_Avoid_: lesson plan, course plan

**next exercise**:
The exercise selected by the learner's current roadmap for the next practice step. It is not an arbitrary Task 1/Task 2, topic, or difficulty selected by the bot.
_Avoid_: custom exercise, requested exercise type

**exercise precreation**:
The WISPACE command that generates or prepares the next roadmap exercise and returns its practice link. It does not mean the learner has opened, attempted, or completed the exercise.
_Avoid_: exercise attempt, exercise completion, exercise assignment

**exercise precreation status**:
The outcome of a precreation request: `created`, `already_exists`, `finished_all`, or `no_roadmap`. The status flags are authoritative; the backend `message` is only explanatory context.
_Avoid_: exercise state (which may mean the learner's practice state)

**exerciseUrl**:
The HTTPS link returned by WISPACE for opening the generated or already-existing next exercise.
_Avoid_: exercise link without the `exerciseUrl` field name

**idempotent exercise precreation**:
Repeated precreation requests for the same roadmap position do not create duplicate exercises; WISPACE returns the existing exercise instead.
_Avoid_: duplicate prevention in the bot

**UserCalendar API**:
Wispace API endpoint for reading a user's study sessions. Authenticated via the platform header (`x-psid`, `x-discordid`, or `x-zaloid`). Returns `UserCalendarRecord[]`.
_Avoid_: calendar API without "User" prefix

**User/goals API**:
Wispace API endpoint for reading target score and exam date. Returns `UserGoalsRecord`.
_Avoid_: goals API without "User/" prefix

**TaskScoreAverage API**:
Wispace API endpoint for reading average IELTS writing scores. Returns `TaskScoreAverageRecord`.
_Avoid_: scores API without "TaskScoreAverage" prefix

**contract drift**:
WISPACE upstream changing response shape without notice — an HTTP 200 whose body no longer matches the expected record. Caught at the client boundary by each client's zod schema (ADR-0010): missing or wrongly-typed required fields fail closed; extra fields are tolerated. The alternative — coercing or dropping malformed data silently — corrupts downstream state (e.g. a dropped calendar row cancels a study job that should exist).
_Avoid_: schema mismatch, bad payload — name the direction: the upstream drifted

**x-psid**:
HTTP header sent to the Wispace API to identify the user. Is the PSID of the Messenger user.
_Avoid_: user header, auth header

**X-Internal-Key**:
HTTP header for Wispace internal API authentication. Maps to env var `WISPACE_INTERNAL_KEY`.
_Avoid_: internal auth, service key

### Architecture

**Clean Architecture**:
4-layer pattern: `domain` (pure types/interfaces) → `application` (services/use cases) ← `infrastructure` (TypeORM, HTTP clients) → `presentation` (controllers).
_Avoid_: hexagonal architecture, onion architecture

**port**:
DI token (Symbol + interface) for cross-module communication. Examples: `MESSAGE_SENDER`, `MESSENGER_REPOSITORY`, `MAPPING_READER`. Platform-neutral names win as a port moves into a shared package — `MESSENGER_MAPPING_READER` became `MAPPING_READER` when Discord and Zalo started using it.
_Avoid_: standalone interface — a port is specifically a DI token pair

**capability port**:
A narrow interface describing one thing a bot can do, named for the capability rather than for the service behind it — `GoalsCapabilityPort`, `CalendarCapabilityPort`, `ExerciseCapabilityPort`. Shared code depends on these; each bot wires a thin adapter and bakes its own platform identity header there. This is what keeps shared packages from importing a concrete client.
_Avoid_: data port, service interface

**platform handler**:
Application-owned execution or result-decoration logic for an agent tool on one platform. Shared tool specs and metadata may classify a tool, but platform handlers own platform ports, identity wiring, and delivery-specific behavior.
_Avoid_: tool spec, shared executor when referring to platform-owned behavior

**executor conformance**:
Proof that every registered tool's capability rules are enforced consistently by every production platform executor, including identity, explicit intent or confirmation, write budget, bounded policy metrics, and incomplete-handler rejection.
_Avoid_: executor parity, handler coverage without policy checks

**delivery failure classification**:
Platform-owned interpretation of an outbound delivery failure that decides whether a durable job is terminal or retryable and supplies the bounded error text to persist. It is distinct from the provider's `OutboundDeliveryOutcome`.
_Avoid_: delivery outcome (that is the provider acknowledgement), retry decision without the delivery context

**adapter**:
Implementation of a port, bridging domain interfaces and infrastructure services.
_Avoid_: implementation, service implementation

**composition root**:
The application wiring boundary where concrete adapters are bound to ports. A composition root may name infrastructure and platform services; feature application code may not.
_Avoid_: service locator, concrete dependency in a use case

**bot bootstrap**:
The shared startup contract for the three WISPACE bots: process-failure handling, Vault/runtime-secret setup, common Nest application configuration, and graceful shutdown. It belongs at the composition root and does not own platform behavior.
_Avoid_: generic bootstrap, platform lifecycle

**outbox pattern**:
Pattern used for `study_reminder_jobs` and `report_send_jobs`: write job rows first, then process asynchronously. Provides durability and retry.
_Avoid_: queue pattern, task queue

**locked tick**:
One scheduled execution attempt that either acquires its shared advisory lock and runs, or skips when another worker owns the lock. A locked tick coordinates one bounded batch; it does not own item persistence transitions.
_Avoid_: cron run, database lock

**bounded batch worker**:
A scheduled worker that processes at most its configured batch for one tick, records per-outcome counts, and returns a summary. Empty input is a successful zero-work tick, not a failure.
_Avoid_: unbounded drain, queue consumer

**batch orchestration**:
The coordination layer around a bounded batch: enabled/config resolution, locked-tick execution, item-loop outcome accounting, and summary construction. Claim, lease, retry, and stuck-row state transitions remain persistence responsibilities.
_Avoid_: persistence workflow, claim loop

**fan-out**:
Ambiguous in this repo — always qualify it. Four unrelated meanings are in active use:
_upstream fan-out_, one scheduled tick making one WISPACE call per learner, the linear-cost concern behind the scheduled crons;
_delivery fan-out_, the same logical message reaching a learner more than once (a second channel, a second tick, a retry storm), the defect class the per-learner claim boundaries exist to prevent;
_erasure fan-out_, a privacy deletion deliberately crossing every platform for one learner;
_alert fan-out_, the Alertmanager routing tree dispatching one alert to several receivers.
The first two pull in opposite directions — fewer per-learner upstream calls is a goal, any delivery fan-out is a bug — so an unqualified "fan-out" in an issue title reads as either.
_Avoid_: bare `fan-out`; also do not read it as the social-feed read/write distribution pattern, which this domain has no use for — every message has exactly one recipient.

**Turborepo monorepo**:
Project structure: `apps/` (Messenger, Discord, Zalo bots) + `packages/` (shared code). Built with Turborepo.
_Avoid_: monorepo without "Turborepo"

**framework-agnostic**:
Said of a package whose enforced core imports no NestJS, no TypeORM and no vendor SDK, so any bot can use it. It describes named core paths, not always a whole package — several packages ship explicit outer adapters alongside a pure core.
_Avoid_: "pure package", "no dependencies" — the claim is about framework coupling, not about having none

> This glossary deliberately does not inventory `packages/`. That list changes with almost every architecture PR, and two copies of it means the copy nobody edits goes wrong. Boundaries, allowed imports and the per-package exception map live in [`docs/architecture-boundaries.md`](docs/architecture-boundaries.md) and [`.claude/rules/clean-architecture.md`](.claude/rules/clean-architecture.md), which are updated with the code they describe. Define vocabulary here; look up structure there.

### Naming Conventions

| Use                  | Avoid                                                 | Reason                                                      |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `externalUserId`     | `platformUserId`, `botUserId`                         | Cross-platform standard name                                |
| `psid`               | `senderId`, `facebookId`                              | Matches Meta terminology                                    |
| `userId`             | `wispaceId`, `internalId`                             | WISPACE internal ID, always numeric                         |
| `sessionKey`         | `sessionId`, `calendarId`                             | Composite key, not a DB PK                                  |
| `remindAt`           | `sendAt`, `notifyAt`                                  | Domain-specific: when the reminder fires                    |
| `scheduledAt`        | `startTime`, `eventTime`                              | Matches UserCalendar API field                              |
| `exerciseTopic`      | `topic` when referring to a future exercise parameter | `topic` already means notification topic in account linking |
| `quota`              | `limit`, `allowance`                                  | Distinguishes daily cap from burst limit                    |
| `reserve` / `refund` | `allocate` / `rollback`                               | Financial metaphor, domain-specific                         |
| `flush`              | `process`, `drain`                                    | Specific to debounce queue                                  |
| `sync`               | `refresh`, `reload`                                   | Specific to UserCalendar → jobs pipeline                    |
| `dispatch`           | `send`, `deliver`                                     | Specific to job → message pipeline                          |
| `feature`            | `useCase`, `purpose`                                  | LLM usage categorization tag                                |
| `correlationId`      | `traceId`, `requestId`                                | Pairs LLM calls with triggering events                      |
| `band`               | `score`, `grade`                                      | IELTS scoring terminology                                   |
| `examDate`           | `testDate`                                            | Matches UserGoals API field                                 |
| `cadence`            | `frequency`                                           | Matches code and type names                                 |
| `postback`           | `buttonClick`                                         | Messenger platform terminology                              |
| `dead letter`        | `failed queue`                                        | Standard messaging pattern                                  |
| qualified `fan-out`  | bare `fan-out`                                        | Four meanings in this repo, two of them opposite            |
