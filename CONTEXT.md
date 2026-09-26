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
Platform-specific user identifier — the Facebook-assigned `psid` on Messenger, a Discord user ID, a Zalo UID. Stored in the `external_user_id` column of every platform mapping table. Used in cross-platform packages.
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
String discriminator on most entities and cross-platform types (`'messenger'`, `'discord'`, `'zalo'`). Allows multi-bot shared database.
_Avoid_: channel, service

**platform storage**:
The one registry stating, per platform, which table and column hold its mapping rows and its verify-intent rows. `PLATFORM_STORAGE` in `@wispace/contracts`, exhaustively keyed by `platform` so a missing entry is a compile error; one platform's entry is a `PlatformStorage` descriptor. The only place platform names may be turned into storage facts. Redis key prefixes, privacy cleanup store sets, priority order, and lock identifiers are **not** platform storage and keep their own registries.
_Avoid_: platform capability metadata (that phrase is the LLM tool vocabulary), platform config

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

**platform mapping table** (DB table):
One mapping table per platform — `user_platform_mappings`, `discord_account_links`, `zalo_account_links`. They are siblings, not one primary table plus two: all three carry `platform`, `external_user_id`, and `link_state`, and they differ in primary-key type (`int` on Messenger, `bigint` on the other two) and in the Messenger-only `status`, `cadence`, and `topic` columns.
_Avoid_: primary mapping table, link table, account link table

**user_platform_mappings** (DB table):
The Messenger platform mapping table (entity: `UserPlatformMappingEntity`). Its name is legacy from when it was the only mapping table. Stores `user_id`, `external_user_id`, `platform`, `cadence`, `topic`, `status`.
_Avoid_: primary mapping table (it is one of three siblings), user_messenger_mappings (migrated to new name)

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
Final learner report assembled from an LLM-written `headline` and factual fields derived deterministically from source data, including practice counts and task statuses.
_Avoid_: AI report (that is the formatted message the user sees)

**StudentReportProse**:
The LLM-authored portion of a student report: one `headline`; factual report fields are derived from source data.
_Avoid_: report output (that means the complete `StudentCapacityReport`)

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
Daily usage allowance for FREE_FORM interactions. Linked turns consume the
learner bucket for `(WISPACE userId, usageDate)` across platforms; anonymous
turns consume the anonymous bucket for `(platform, externalUserId, usageDate)`.
Identity churn never merges, resets, or transfers either bucket.
_Avoid_: limit (used for burst limit), allowance

**learner bucket**:
The daily FREE_FORM usage bucket owned by one WISPACE `userId`. It survives
unlinking and relinking, and is shared by that learner's linked platforms for
the same usage date.
_Avoid_: linked row, account counter

**anonymous bucket**:
The daily FREE_FORM usage bucket owned by one `(platform, externalUserId)`
pair when no WISPACE `userId` is attached. It is independent from every
learner bucket and is not adopted when the channel later links.
_Avoid_: guest quota, temporary bucket

**quota charge owner**:
The learner bucket or anonymous bucket selected when a FREE_FORM reservation
is made. Refund and stuck-reservation recovery use this owner snapshot rather
than the mapping that happens to be current later.
_Avoid_: current link owner

**chat_daily_usage** (DB table):
Daily usage counter table. Entity: `ChatDailyUsageEntity`. Stores counts for
learner and anonymous buckets without rewriting one bucket into the other.
_Avoid_: messenger_chat_daily_usage (old name)

**freeFormCount**:
Number of FREE_FORM interactions a user has consumed today. Atomically incremented on reserve.
_Avoid_: usage count, chat count

**reserve**:
Atomic operation: (1) check burst limit, (2) insert idempotency row with status `reserved`, (3) increment `freeFormCount`. Returns `ChatQuotaCheckResult`.
_Avoid_: allocate, claim

**refund**:
Reverses a reservation when the LLM call or Send API fails before the user receives the message. Changes idempotency status to `refunded` and decrements the counter belonging to the reservation's quota charge owner, even if linking changed afterward.
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
Short-term (per-minute) rate limit to prevent spam. Checked before daily quota
and scoped to the platform/external identity, independently of learner and
anonymous daily buckets. Configured via `CHAT_BURST_PER_MINUTE`.
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

**chat turn**:
One free-form learner interaction that produces one agent response; a flushed `ChatQueueBatch` is one turn even when it contains several messages.
_Avoid_: message, batch

**userTextParts**:
The ordered raw learner messages in the current `ChatQueueBatch`, kept separate from the model-facing merged text for safety decisions.
_Avoid_: merged text, history entry

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

**agent run**:
One execution of the free-form agent for a learner interaction. It may contain multiple tool rounds and is one kind of LLM generation; a later queue flush replay is a new agent run.
_Avoid_: provider call, chat turn — a chat turn can have more than one agent run when its flush is replayed

**LLM generation**:
One top-level operation that asks an LLM to produce one feature result. A chat generation is an agent run; a report or reminder generation may have no tool rounds.
_Avoid_: provider attempt, chat turn

**08:00 report wave**:
The set of scheduled-report jobs selected by one platform's 08:00 ICT report tick. Retry-dispatch jobs are later attempts, not part of the original wave.
_Avoid_: report cron (which can also mean retry dispatch), report fan-out

**background producer concurrency**:
The maximum number of report or study-reminder generations a producer starts at once before they contend for LLM admission. It is a producer-side cap, distinct from the admission queue's provider-execution limit.
_Avoid_: admission concurrency, provider concurrency

**background admission capacity**:
The number of background generations that can be admitted within the background wait budget, combining immediately available execution slots with only the queue depth that can drain before that budget expires. It is distinct from the configured maximum queue depth.
_Avoid_: queue capacity, background throughput

**capacity overload**:
A pre-provider admission rejection caused by queue or slot capacity (`queue_full`, `wait_timeout`, or `global_saturated`). `redis_unavailable` is an infrastructure failure, not capacity overload.
_Avoid_: provider overload, execution failure

**LLM admission contract**:
The single bounded decision boundary shared by interactive chat, reports, and study reminders in one bot process. It covers local capacity and, when enabled, the Redis aggregate budget; it produces one typed pre-provider outcome and never silently bypasses an enabled global budget.
_Avoid_: feature-local limiter, provider retry

**admission coordinator**:
The owner of one LLM admission attempt across local capacity and the optional global lease. It admits a generation only after both scopes are available, and releases the local permit before waiting or backing off for global capacity.
_Avoid_: local queue, Redis limiter

**admission probe**:
One bounded attempt to pair a local permit with a global lease. A probe is not a provider attempt; when global capacity is unavailable, the local permit is released before the request is re-queued or rejected.
_Avoid_: retry attempt, provider probe

**local admission permit**:
A short-lived process-local permit used for one admission probe or an admitted provider generation. It is not held across global-capacity backoff or retry waits.
_Avoid_: local slot, provider slot

**global admission lease**:
An owner-fenced Redis lease that limits aggregate LLM generations across participating processes. One lease covers the provider retries and failover of one generation and is released when that generation ends; when the Redis budget is disabled, no cross-bot fairness guarantee is claimed.
_Avoid_: global lock, Redis counter

**shared process admission**:
The one local LLM capacity budget of a bot process, shared by chat, reports, and reminders. It is distinct from per-learner fairness and from the fleet-wide Redis aggregate budget.
_Avoid_: feature pool, bot-wide quota

**admission wait**:
The time before a generation is admitted. Local queue wait and global lease wait are measured separately, while one caller deadline covers both and all later provider work.
_Avoid_: provider latency, retry delay

**overload-induced regeneration**:
A new LLM generation for the same logical report or reminder after its previous generation ended with capacity overload and was persisted for retry. Provider retries inside one generation and retries caused by other failure classes are not overload-induced regeneration.
_Avoid_: provider retry, queue replay

**report retry cause**:
A bounded, durable classification attached to a report retry job, such as `capacity_overload`, that explains why the job was requeued. It is authoritative for retry attribution; `last_error` remains human-readable context and is not the classification contract.
_Avoid_: error message, retry status

**wave completion deadline**:
An operational target for when an 08:00 report wave should finish, separate from the rolling report-delivery SLO. The current target is 09:00 ICT; missing it is a latency signal even when the eventual delivery is successful.
_Avoid_: report SLO, retry deadline

**shared provider-attempt budget**:
The maximum number of actual provider calls allowed during one LLM generation, consumed across agent retry, execution retry, and provider failover. It counts the initial call, does not count admission/cooldown skips, and does not carry across queue flush replays.
_Avoid_: retry count, quota, admission cap

**budget exhaustion**:
The condition in which an LLM generation has no remaining provider-call allowance. It stops the next retry or failover call while preserving the existing terminal cause, and is distinct from an abort, deadline, or provider exhaustion outcome.
_Avoid_: timeout, provider exhaustion, quota

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

**tool observation**:
The projected, sanitized, bounded content returned by one tool execution and sent as a `role='tool'` message for its provider tool call. It is current-turn grounding data, not the raw executor payload.
_Avoid_: raw tool result, tool transcript

**observation age**:
The number of tool rounds between an observation's origin round and the current round (`currentRound - originRound`). It is distinct from chat-turn age and history age.
_Avoid_: model age, chat-turn age

**stale observation**:
A tool observation whose age reaches the configured `staleObservationRounds` threshold and is eligible for downgrade; recent failed observations remain protected.
_Avoid_: stale history, expired observation

**observation downgrade**:
Replacing an already sanitized stale observation with a compact bounded marker before the next provider request, while keeping message roles, tool-call IDs, and provider pairing unchanged.
_Avoid_: observation deletion, history trimming

**tool schema**:
The single zod schema per agent tool (ADR-0010). The provider-facing JSON Schema, the argument type, and runtime argument validation all derive from it — never hand-written separately. Capability metadata (effect/identity/authorization/confirmation/idempotency) sits alongside it, not inside it.
_Avoid_: tool definition JSON, hand-written schema, three representations

**requested limit**:
The learner- or model-supplied bound before validation and policy maximums are applied.
_Avoid_: raw limit, requested count

**effective limit**:
The validated bound actually used by a calendar read after policy maximums are applied.
_Avoid_: clamped limit, returned count

**returned count**:
The number of records actually present in a tool result after all query bounds. It is not a pre-slice count or a claim about total available records.
_Avoid_: pre-slice count, total count, available count

**capped result**:
A calendar read whose effective `limit` or `pastDays` is lower than its requested value; it discloses that it is bounded rather than implying completeness. Independent same-tool query scopes keep separate disclosures and summary lines; one result never supplies the other's count or time range.
_Avoid_: truncated complete list, exact result

**result completeness**:
Whether a tool result includes all records matching its query. Completeness is `incomplete` or `unknown`; returned count alone does not prove completeness.
_Avoid_: returned count, has-more inference

**known remaining data**:
Records that the upstream source confirms exist beyond the returned page. It is distinct from a capped result and cannot be inferred merely by reaching the cap.
_Avoid_: hasMore, silent extra records

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
A bounded history record of the tools consulted during one learner turn and compact outcomes that may help interpret a follow-up. It is advisory context only; when replayed it is previous-turn synthesis that may be stale, so fresh current-turn tool data wins any conflict while non-sensitive identifiers may still support a follow-up when no conflict exists.
_Avoid_: fresh result, cached answer

**replayed tool summary**:
The provider-facing form of a stored tool summary from a previous learner turn. It is explicitly advisory and potentially outdated, and never outranks fresh tool data for a conflicting fact.
_Avoid_: current tool result, authoritative history

**result line**:
A deterministic, one-tool line in a tool summary that reports a small set of structured outcome facts without model-written paraphrase.
_Avoid_: prose summary, tool transcript

**identifier section**:
A separate bounded part of a tool summary for server-issued identifiers needed by a follow-up action, such as `exerciseUrl` or `calendarId`. It is agent context, not learner-facing prose.
_Avoid_: inline identifier, learner-provided ID

**fresh tool data**:
Structured data returned by a tool during the current learner turn. It is the authority for answering current progress, goal, schedule, and exercise questions, and wins over replayed summaries or prose history when sources conflict.
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

**learner admission key**:
The identity used for per-learner LLM concurrency: the linked WISPACE `userId`, or the `(platform, externalUserId)` pair for an anonymous turn. It is a snapshot for one execution and is not changed by a later relink.
_Avoid_: user ID, platform user ID

**per-user in-flight cap**:
The maximum number of concurrent free-form chat executions admitted for one learner admission key, including executions waiting for capacity or retrying a provider call. It protects interactive fairness and is distinct from the daily chat quota.
_Avoid_: per-user rate limit, concurrency quota

**user-saturated**:
The typed admission outcome returned when a learner already has the allowed number of in-flight LLM executions.
_Avoid_: queue full, global saturated

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

**provider outcome**:
The result of one actual call to a configured LLM provider: `success` when it returns a completion and `failure` when that call is rejected or errors. Missing usage metadata does not change a successful completion into a failure. Caller cancellation and an execution deadline that expires before a provider call are not provider outcomes; a provider-side attempt timeout is a provider failure for the execution circuit even though it arrives as an abort. A cooldown skip is not an outcome because no provider call occurred.
_Avoid_: request outcome, circuit state

**deterministic request rejection**:
A provider refusal caused by the learner's request or payload, represented by normalized reason `bad_request`. It is observable as a failed provider call but is not evidence that the shared provider is unhealthy.
_Avoid_: provider outage, upstream failure

**upstream-health signal**:
A provider-side result that can indicate a shared dependency problem and may count toward the execution circuit; it includes network, timeout, server, rate-limit, quota, auth, and otherwise unknown provider failures. A deterministic request rejection and caller cancellation are not upstream-health signals.
_Avoid_: per-learner error, request rejection

**caller cancellation**:
Cancellation initiated by the caller's own signal. It ends the current LLM generation immediately, is never retried, and is excluded from execution-circuit failure counts.
_Avoid_: provider timeout, execution deadline

**provider-side attempt timeout**:
Expiry of the bounded timeout for one provider attempt while the caller and global execution deadline are still active. It indicates a slow provider, may be retried when the provider classifier allows it, and contributes to an execution-circuit failure when the top-level execution ultimately fails.
_Avoid_: caller cancellation, global execution deadline

**global execution deadline**:
The single time budget for one LLM execution, covering admission, the optional shared slot, retries, backoff, and provider calls. Once it expires no new provider attempt starts; its failure is attributed to the provider only when a provider attempt was in flight.
_Avoid_: per-attempt timeout, caller cancellation

**execution-circuit failure**:
One terminally failed top-level LLM execution attributed to a provider call or to a global deadline expiring while a provider call was in flight. It increments the shared execution circuit once per execution, not once per retry attempt, and excludes admission, Redis, and caller-cancellation failures.
_Avoid_: retry attempt, provider circuit failure

**long cooldown**:
Temporary suppression applied after a provider reports `quota_exceeded`, `auth`, or `rate_limit`. It has a timer and may be probed again; it is not a provider quarantine.
_Avoid_: quarantine, permanent disable

**provider quarantine**:
Process-lifetime exclusion of a configured provider after repeated consecutive authentication failures. A quarantined provider is removed from rotation until the process restarts; it is distinct from a timed long cooldown.
_Avoid_: cooldown, disabled provider

**never-served provider**:
A configured provider with no successful completion in the current provider-health window. A successful completion resets the window, and repeated long-cooldown outcomes make it alertable; it does not claim that the provider is permanently misconfigured.
_Avoid_: unhealthy provider, dead provider

**provider/model cost attribution**:
The cost estimate attached to the provider and model that actually returned a completion. A primary provider's price must not be reused for a completion served by a different provider; model-only pricing is a compatibility convention only when no failover ambiguity exists.
_Avoid_: primary-model cost, estimated vendor cost

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

**practice role**:
A fictional role the learner asks the bot to portray within an explicit practice scenario, such as an IELTS examiner, interviewer, customer, or teacher. It shapes the exercise but does not change the assistant's actual instructions or limits.
_Avoid_: persona override when referring to benign roleplay

**grounding check**:
Verification that the LLM response is actually grounded in tool results (no hallucination). Performed by `checkLlmGrounding()`. Logs a warning if suspicious.
_Avoid_: hallucination check

**sanitizeUntrustedTextForLlm**:
Utility function that strips/escapes potentially dangerous content from user or Wispace data before inserting it into prompts or tool results.
_Avoid_: escape, encode — use "sanitize"

**canonical scan view**:
Bounded safety text formed from the current `userTextParts` and the newest sanitized user-authored history entries; it is not the prompt sent to the model.
_Avoid_: full history, merged prompt

**joint-scan**:
Supplemental prompt-injection scan across boundaries between current `userTextParts` and recent user-authored history. It reuses the existing pattern set and does not replace the single-turn scan.
_Avoid_: conversation-wide scan, multi-turn classifier

*_system prompt / *.system.txt*_:
Instructions sent in the system role. A prompt may be owned by a feature and shared across bots; each bot packages the prompts it uses at build time.
_Avoid_: prompt file, AI instructions — use "system prompt"

**prompt core / overlay**:
The free-form chat prompt is composed, not stored in one file: `CHAT_SYSTEM_PROMPT_CORE` (`packages/llm-agent/src/chat-system-prompt.ts`) holds every universal rule and is shared by all three bots; each bot's `<platform>-chat.system.txt` is the **overlay**, carrying only what is platform-specific. `composeChatSystemPrompt()` joins core → overlay → data-only `Process marker: <value>` → suffix. A rule stated in the core is never copied into an overlay (`prompt-overlay-dedup.spec.ts`). The core has a size budget asserted in `chat-system-prompt.spec.ts`.
_Avoid_: "the chat prompt file" — there is no single file

**posture**:
The action a chat turn resolves to — answer, tool call, scope redirect, acknowledge-then-step, refuse-then-offer, non-disclosure line, de-escalate, support handoff, clarify. A closed set with one precedence order; adding one amends ADR-0009. Prompt sections are written per posture, not per kind of learner message.
_Avoid_: branch, rule, category

**crisis posture**:
The highest-priority chat posture for a credible self-harm, suicidal-intent, immediate-danger, or self-harm-instruction disclosure. It performs a brief Vietnamese support handoff without tools, study advice, diagnosis, counselling, or a WISPACE scope redirect; it is distinct from the optional `CRISIS` classifier label.
_Avoid_: crisis label when referring to learner-facing behavior

**abuse posture**:
The posture for hostility aimed at the assistant or a request to generate degrading, threatening, harassing, or insulting content about an identifiable third party. It does not include ordinary study frustration, constructive critique, or analysis/translation of quoted text.
_Avoid_: profanity filter, keyword block, abuse escalation

**bot-directed hostility**:
A learner message that attacks or insults the assistant; it receives the fixed calm Writing deflection rather than an argument or a study answer.
_Avoid_: study frustration, abuse escalation

**targeted abusive content**:
Requested output whose purpose is to humiliate, threaten, harass, or insult a specific person or target, including when framed as a Writing exercise. Factual or constructive criticism is not targeted abusive content.
_Avoid_: negative writing, criticism

**fallback reply**:
Canned response used when the LLM provider is unavailable (not configured, or every failover target failed). Not LLM-generated.
_Avoid_: default reply, error reply

### LLM Usage Tracking

**llm_usage_events** (DB table):
Records token usage for each LLM call. Entity: `LlmUsageEventEntity`. Fields: `feature`, `model`, `promptTokens`, `completionTokens`, `totalTokens`, `estimatedCostUsd`, `toolRound`, `status`, `errorMessage`.
_Avoid_: token log, usage log

**zero-token failure row**:
A usage event recorded in `llm_usage_events` with `status: 'error'`, zero token counts (`prompt_tokens: 0`, `completion_tokens: 0`, `total_tokens: 0`), and a bounded failure class in `errorMessage`. Emitted when an LLM call fails without producing a completion across `FREE_FORM_CHAT`, `STUDENT_REPORT`, and `STUDY_REMINDER`. It never contains raw error text or external identifiers in `errorMessage`.
_Avoid_: error log, failed token event

**estimatedCostUsd**:
Estimated cost in USD for an LLM call, calculated from token counts and model pricing (`LLM_COST_USD_PER_1M_*`). Not the actual invoice amount.
_Avoid_: cost without "estimated"

**fleet**:
All instances of the bot application combined. "Fleet summary" = aggregated usage across all pods. Accessed via `GET /messenger/ops/llm-usage/fleet`.
_Avoid_: cluster, deployment

### LLM Safety

**llm_safety_events** (DB table):
Records safety-related events (grounding warnings, prompt injection blocks, classifier verdicts, and harmful-output blocks). Entity: `LlmSafetyEventEntity`. Learner or assistant text is never stored raw — only a redacted excerpt plus a hash.
_Avoid_: safety log, security events

**grounding warning**:
Event logged when an LLM response appears to hallucinate (not grounded in tool results). Contains `reason`, `userTextPreview`, `assistantTextPreview`, `toolNamesUsed`.
_Avoid_: hallucination event

**redact**:
Replacing credential-shaped substrings with `REDACTED_PLACEHOLDER` (`'[REDACTED]'`). Applies on both sides of the model boundary — inbound text before the provider call, and outbound text before it reaches the learner — from one shared list of shapes (`CREDENTIAL_SHAPES`).
_Avoid_: censor, block; do not confuse with **sanitize** (neutralizing injection payloads) or with the excerpt-plus-hash storage rule for safety events

**classifier / verdict**:
Second-tier input check admitted only after the tier-1 preflight: one fresh learner message in, one `ClassifierVerdict` out (`label`, `confidence`, `reason`). Tier-1 single-turn, joint-scan, and length guards are authoritative; a classifier verdict can never downgrade a tier-1 hit to `SAFE`. The classifier treats learner content as untrusted data, so instructions inside the message to control its label, confidence, reason, or JSON verdict are `INJECTION`. Labels are `SAFE`, `INJECTION`, `DISCLOSURE_PROBE`, `ABUSE`, and `CRISIS`; `CRISIS` is a measurement/enforcement signal, not the learner-facing posture itself. In shadow mode a non-`SAFE` verdict is recorded without changing the reply; in enforce mode a qualifying verdict can select its fixed safety posture, and `CRISIS` uses the crisis handoff without the normal confidence floor. Classifier unavailability is a separate typed outcome, never a synthetic `CRISIS` verdict: shadow mode continues the normal path with bounded telemetry, while enforce mode uses the deterministic classifier safety fallback before the main LLM.
_Avoid_: moderation, filter — it decides nothing on its own

**classifier invocation**:
One attempt to obtain a classifier verdict after the classifier's skip guards have passed while execution control is enabled. Its hard deadline covers admission wait and provider execution; it may end before provider execution because the local circuit or shared admission rejects it, and it is distinct from the provider call itself.
_Avoid_: provider attempt, chat turn

**admitted classifier provider call**:
A classifier invocation that passes shared local and fleet admission and reaches the provider once. It retains the classifier's hard deadline, no-retry behavior, and separate local circuit rather than inheriting the main chat circuit policy.
_Avoid_: classifier invocation, chat generation

**classifier admission rejection**:
A classifier invocation refused before provider execution because bounded local capacity, the Redis-global slot, or Redis availability cannot admit it. Its closed reasons are `queue_full`, `wait_timeout`, `global_saturated`, and `redis_unavailable`; it is fail-open and never becomes a fabricated verdict.
_Avoid_: provider failure, classifier says safe

**classifier unavailable**:
The classifier could not produce a usable verdict because of timeout, provider error, rate limiting, invalid output, an open local circuit, classifier admission rejection, caller cancellation, or disabled execution control. It is not evidence that the learner input is safe or a crisis; the caller applies the mode-specific safety fallback and records only bounded failure metadata. The bounded failure labels are `timeout`, `error`, `rate_limited`, `parse_failed`, `aborted`, `skipped_circuit_open`, `queue_full`, `wait_timeout`, `global_saturated`, `redis_unavailable`, and `execution_disabled`.
_Avoid_: classifier says safe, crisis fallback — neither is implied by an unavailable result

**classifier breaker failure classes**:
The partition of classifier failure outcomes for the local circuit breaker. **Dependency-shaped** failures (`timeout`, `error`, `rate_limited`) indicate upstream provider distress, accumulate toward tripping the breaker, and re-open the circuit if seen during a half-open probe. **Input-shaped** failures (`parse_failed`) indicate learner-specific formatting anomaly with a healthy provider; they fail open for that turn but never increment the breaker's failure counter and close the circuit if received during a half-open probe. Admission rejections, caller cancellation, and disabled execution bypass breaker accounting.
_Avoid_: shared execution circuit, global safety trip

**classifier execution mode**:
The shared execution policy reserved for the input classifier: one provider attempt, no shared retry/circuit side effects, shared local/fleet admission, and an end-to-end classifier deadline. When execution control is disabled, the optional classifier is skipped rather than bypassing this policy.
_Avoid_: chat execution mode, passthrough classifier

**classifier reason telemetry**:
The bounded explanation emitted by the classifier and persisted for a non-`SAFE` verdict. Policy routing may inspect the in-memory reason, but persisted safety events contain only a redacted excerpt and optional hash/length metadata; raw model-generated reason text never crosses the persistence boundary.
_Avoid_: model rationale, raw reason

**classifier input ceiling**:
The maximum number of Unicode code points in the redacted learner text sent to the second-tier classifier. It bounds classifier cost; exceeding it selects a bounded head-and-tail sample instead of silently dropping one side of the message.
_Avoid_: chat message limit, tier-one length limit

**head-and-tail sample**:
A bounded classifier view that preserves the beginning and end of a learner message and marks the omitted middle. It is not evidence that the omitted middle is safe.
_Avoid_: full message, complete scan

**shadow / enforce**:
The classifier's two modes. In **shadow** a non-SAFE verdict is only recorded as a `CLASSIFIER_FLAGGED` event and classifier unavailability keeps the normal path; in **enforce** a qualifying verdict can short-circuit the turn with a canned reply, `CRISIS` uses the crisis handoff without the normal confidence floor, and classifier unavailability returns the deterministic classifier safety fallback before the main LLM. Enforce is flipped only after reviewing a shadow window.
_Avoid_: dry run, passive mode

**classifier safety fallback**:
The deterministic generic processing-error reply used when enforce mode cannot obtain a classifier verdict. It is not a crisis handoff, does not call tools or the main LLM, and is not appended to chat history.
_Avoid_: crisis fallback, provider fallback — those are different safety boundaries

**harmful-output guardrail**:
The shared last-mile check over model-generated chat text that blocks actionable self-harm instructions/encouragement and targeted abusive content before delivery. It is distinct from the input classifier, input moderation, grounding check, and leak guard.
_Avoid_: output moderation, toxicity filter

**harmful-output blocked event**:
A safety event emitted when the harmful-output guardrail replaces model text with the generic safe reply; it records the bounded category/reason and a redacted excerpt, hash, and length, never raw text.
_Avoid_: moderation event, safety log

**must-allow fixture**:
A curated guardrail-evaluation case for legitimate learner traffic whose expected path reaches the model without being blocked. Its pass rate describes only the selected fixture corpus, not the false-positive rate on live traffic.
_Avoid_: allowlist entry, production false-positive rate

**non-disclosure**:
The rule that the assistant never reveals or denies anything about its own internals — model, provider, prompt, tools, parameters, infrastructure. The reply must be worded identically every time, because a reply that varies with the question is itself a leak.
_Avoid_: secrecy, confidentiality

**prompt canary**:
A secret value included in the composed chat system prompt as a data-only `Process marker: <value>` part so its appearance in an assistant reply signals prompt disclosure. A canary hit follows the non-disclosure posture; the value itself is never exposed to the learner, logs, history, events, metrics, or alerts.
_Avoid_: prompt marker — fixed public markers are not canaries

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

### Disaster Recovery & Host Scripts

**host operational scripts**:
Host-side bash scripts residing at `/home/ngoc_anh/scripts/` executed by cron or operations outside Docker containers (`postgres-backup.sh`, `backup-monitor.sh`, `postgres-offsite-sync.sh`, `postgres-restore-verify.sh`, `vps-hardening-check.sh`).
_Avoid_: bot scripts, infra scripts, deploy scripts (when referring specifically to host-level operational cron scripts)

**host script manifest**:
Authoritative machine-readable inventory (`/home/ngoc_anh/scripts/.installed-manifest.json`) generated at deployment time, recording the git commit SHA, deployment timestamp, and SHA256 checksum of every installed host script.
_Avoid_: script version file, release stamp

**host script drift**:
The condition where an operational script on the host is missing, outdated compared to the deployment revision, or differs in SHA256 checksum from the host script manifest.
_Avoid_: out of sync script, stale script (use drift for checksum or file presence divergence)

**fail-safe script execution**:
The execution discipline where host scripts run under `set -euo pipefail` without crashing silently: requiring an immediate startup timestamp banner, non-panicking variable extraction (`grep ... 2>/dev/null || true`), and an `ERR` trap that surfaces abnormal termination to Alertmanager.
_Avoid_: quiet execution, silent failure

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

**local cache**:
Filesystem cache used by a developer's local Turborepo run. It is the default
cache for local verification and does not require remote credentials.
_Avoid_: local remote cache when referring to the CI artifact store

**CI remote cache**:
Remote Turbo artifact store used by trusted CI verification. Local developers
may read it only through an approved read-only boundary; local runs do not write
to it.
_Avoid_: shared cache when the trust boundary is relevant

**cache mode**:
The local and remote read/write permissions for one Turbo run. The supported
local opt-in mode reads and writes locally and reads remotely.
_Avoid_: cache policy when referring to one command's permissions

**cache result**:
Whether a task reused an artifact (`HIT`) or had to execute (`MISS`).
_Avoid_: cache source when describing only hit or miss

**cache source**:
Where a reused artifact came from: `LOCAL` or `REMOTE`; a miss has no source.
_Avoid_: cache result when describing the artifact origin

**framework-agnostic**:
Said of a package whose enforced core imports no NestJS, no TypeORM and no vendor SDK, so any bot can use it. It describes named core paths, not always a whole package — several packages ship explicit outer adapters alongside a pure core.
_Avoid_: "pure package", "no dependencies" — the claim is about framework coupling, not about having none

**core entrypoint / adapter entrypoint**:
The public boundary between a package's framework-neutral policy and contracts, and its integrations with frameworks or outside systems. Inner workflows depend on core; composition roots bind adapters.
_Avoid_: mixed package barrel when describing this boundary

**database portability boundary**:
The rule that database-engine-specific persistence code stays behind adapters and infrastructure boundaries, while domain code, application business logic, and public ports remain engine-neutral. It is a boundary about dependencies and observable behavior, not a promise that SQL or migration files are portable.
_Avoid_: portable SQL promise, drop-in database guarantee

**persistence semantics**:
The observable atomicity, concurrency, fencing, ordering, and outcome guarantees exposed by a persistence port and preserved by its adapter.
_Avoid_: SQL syntax contract, query-shape contract

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
| `host scripts`       | `infra scripts`, `host cron scripts`                  | Canonical location `/home/ngoc_anh/scripts/`                |
| `host script manifest`| `version lock`, `script list`                        | Machine-readable JSON inventory on host                     |
| `host script drift`  | `stale scripts`, `dirty scripts`                      | Checksum or presence divergence from manifest               |
