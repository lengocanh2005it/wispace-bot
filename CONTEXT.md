# WISPACE BOTS

NestJS Turborepo monorepo for IELTS student bots — AI reports, study reminders, rate-limited AI chat. Currently features `apps/messenger-bot` (fully functional), `apps/discord-bot` (fully functional), `apps/zalo-bot` (fully functional), with shared packages: `llm-agent`, `chat-metering`, `wispace-client`, `chat-history`, `student-report`, `chat-queue-core`, `study-reminder-core`.

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
Internal numeric WISPACE identifier (integer). Obtained after linking a Messenger account via `ref` or token verification.
_Avoid_: ambiguous "user ID" — always write "WISPACE userId"

**ref**:
Query parameter in `m.me` links. Contains the WISPACE `userId` as a string. Parsed by `parseUserIdFromRef()`.
_Avoid_: reference

**m.me**:
Facebook's short link domain for Messenger. `m.me/{page}?ref={userId}&topic=...&cadence=...` is how Wispace initiates the account-linking flow.
_Avoid_: Messenger link

**platform**:
String discriminator on most entities and cross-package types (`'messenger'`, `'discord'`, `'zalo'`). Allows multi-bot shared database.
_Avoid_: channel, service

### Account Linking

**linking / link**:
The process of pairing a PSID (Messenger) with a WISPACE `userId`. Occurs when a user opens an `m.me` link and the webhook receives the `ref` parameter.
_Avoid_: registration, signup

**MessengerLinkContext**:
Parsed context from an `m.me` link: `{ ref, topic, cadence, userId }`.
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
Ops flag that allows relinking a PSID to a different WISPACE userId (handles L3).
_Avoid_: reassign, rebind

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
Deterministic template report used when OpenAI is unavailable or returns invalid JSON. Generated by `buildFallbackReport()`.
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
_Avoid_: dedup table (deduplication is a separate concern — `CHAT_DEDUPE_STORE`)

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
List of PSIDs exempt from rate limiting (`CHAT_RATE_LIMIT_WHITELIST_PSIDS`). Used for QA/testing.
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

**messenger_message_logs** (DB table):
Audit log of all sent/received messages. Entity: `MessageLogEntity`. Cleaned up by cron (default 90 days).
_Avoid_: message history (that is `CHAT_HISTORY_STORE`)

**MessageSenderPort**:
Cross-module port token (`MESSAGE_SENDER`) for sending messages. Implemented by `MessengerOutboundService`. Used by `StudyReminderModule` to avoid circular dependency.
_Avoid_: injecting `MessengerService` from another module — always use the port

**routeWebhookEvent**:
Pure function that classifies a webhook event into `WebhookAction[]`. Takes `(event, ctx?)`, returns a list of actions. No side effects, no async, no NestJS dependency. Located in `messenger-webhook.router.ts`.
_Avoid_: routeEvent, classifyEvent

**WebhookAction**:
Value describing the action to perform for a webhook event. Types: `link_user`, `enqueue_chat`, `send_text`, `register_report`, `send_report`, `send_reminder_preview`, `confirm_reschedule`, `cancel_reschedule`, `send_welcome`, `ignore`.
_Avoid_: ambiguous action type

**RouterContext**:
Pre-resolved context before calling the router: `{ isDuplicateMid?, isDuplicatePostback?, existingMapping?, linkContext?, linkAttemptStatus? }`. Helps the router make pure decisions (sync, not async).
_Avoid_: routing context, event context

### LLM

**LlmAgentService**:
Framework-agnostic OpenAI function-calling orchestration loop (in `packages/llm-agent`). Manages tool rounds, history, grounding checks, prompt injection detection.
_Avoid_: chat service, AI service

**tool round**:
One iteration of the LLM function-calling loop. The agent can invoke multiple tools per user message, up to `maxToolRounds` (default 6).
_Avoid_: iteration, loop count

**feature**:
String tag for categorizing LLM calls: `'FREE_FORM_CHAT'`, `'STUDENT_REPORT'`, `'STUDY_REMINDER'`. Used for usage tracking and metrics.
_Avoid_: use case, purpose

**correlationId**:
Unique identifier that pairs an LLM call with its triggering event (usually `message.mid` or userId). Used for tracing and usage telemetry.
_Avoid_: trace ID, request ID

**prompt injection**:
Attack where malicious text in user messages or tool results tricks the LLM. Detected by `detectPromptInjection()` and blocked before calling OpenAI.
_Avoid_: injection attack — use "prompt injection"

**grounding check**:
Verification that the LLM response is actually grounded in tool results (no hallucination). Performed by `checkLlmGrounding()`. Logs a warning if suspicious.
_Avoid_: hallucination check

**sanitizeUntrustedTextForLlm**:
Utility function that strips/escapes potentially dangerous content from user or Wispace data before inserting it into prompts or tool results.
_Avoid_: escape, encode — use "sanitize"

**system prompt / *.system.txt**:
Base persona/instructions loaded from `src/shared/prompts/*.system.txt`. Copied to `dist/` at build time. Three variants: `student-report`, `study-reminder`, `messenger-chat`.
_Avoid_: prompt file, AI instructions — use "system prompt"

**fallback reply**:
Canned response used when OpenAI is unavailable (missing API key or error). Not LLM-generated.
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
Records safety-related events (grounding warnings, prompt injection blocks). Entity: `LlmSafetyEventEntity`.
_Avoid_: safety log, security events

**grounding warning**:
Event logged when an LLM response appears to hallucinate (not grounded in tool results). Contains `reason`, `userTextPreview`, `assistantTextPreview`, `toolNamesUsed`.
_Avoid_: hallucination event

**redact**:
Process of replacing suspicious history entries with `'[redacted]'` before sending to OpenAI.
_Avoid_: censor, block

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

### Database & Entities

**ai_chat_bot_db**:
Dedicated PostgreSQL database for the bot. Previously named `writing_ai_hub_db`.
_Avoid_: bot database, main DB

**users** / **"Users"** (view):
Cache table + view on `ai_chat_bot_db` for user display name and exam date. Entity: `UserEntity`. Only contains users with active Messenger mappings.
_Avoid_: user table

**DisplayName**:
User display name from the `users` table / `"Users"` view. Falls back to `'Chao ban nha'` if null. Used in LLM prompts for personalization.
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

**UserCalendar API**:
Wispace API endpoint for reading a user's study sessions. Authenticated via `x-psid` header. Returns `UserCalendarRecord[]`.
_Avoid_: calendar API without "User" prefix

**User/goals API**:
Wispace API endpoint for reading target score and exam date. Returns `UserGoalsRecord`.
_Avoid_: goals API without "User/" prefix

**TaskScoreAverage API**:
Wispace API endpoint for reading average IELTS writing scores. Returns `TaskScoreAverageRecord`.
_Avoid_: scores API without "TaskScoreAverage" prefix

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
DI token (Symbol + interface) for cross-module communication. Examples: `MESSAGE_SENDER`, `MESSENGER_REPOSITORY`, `MESSENGER_MAPPING_READER`.
_Avoid_: standalone interface — a port is specifically a DI token pair

**GoalsDataPort**:
Port for fetching student goals data from the WISPACE API. Method: `getUserGoals(psid)`.
_Avoid_: UserGoalsApiService (that is the adapter implementation)

**ReportPort**:
Port for generating study reports via LLM. Method: `generateReport(psid)`.
_Avoid_: StudentReportService (that is the adapter implementation)

**StudyDataPort**:
Port for retrieving study session and reminder data. Methods: `getUpcomingSessions`, `getNextUpcomingSession`, `generateReminderBundleForSession`, `listCalendarEntries`, `getOutboxSettings`, `formatScheduledTimeLabel`.
_Avoid_: StudyReminderService, StudyCalendarCommandService (those are adapter implementations)

**adapter**:
Implementation of a port, bridging domain interfaces and infrastructure services. Example: `GoalsDataAdapter` wraps `UserGoalsApiService`.
_Avoid_: implementation, service implementation

**outbox pattern**:
Pattern used for `study_reminder_jobs` and `report_send_jobs`: write job rows first, then process asynchronously. Provides durability and retry.
_Avoid_: queue pattern, task queue

**Turborepo monorepo**:
Project structure: `apps/` (Messenger, Discord, Zalo bots) + `packages/` (shared code). Built with Turborepo.
_Avoid_: monorepo without "Turborepo"

### Naming Conventions

| Use | Avoid | Reason |
|-----|-------|--------|
| `externalUserId` | `platformUserId`, `botUserId` | Cross-platform standard name |
| `psid` | `senderId`, `facebookId` | Matches Meta terminology |
| `userId` | `wispaceId`, `internalId` | WISPACE internal ID, always numeric |
| `sessionKey` | `sessionId`, `calendarId` | Composite key, not a DB PK |
| `remindAt` | `sendAt`, `notifyAt` | Domain-specific: when the reminder fires |
| `scheduledAt` | `startTime`, `eventTime` | Matches UserCalendar API field |
| `quota` | `limit`, `allowance` | Distinguishes daily cap from burst limit |
| `reserve` / `refund` | `allocate` / `rollback` | Financial metaphor, domain-specific |
| `flush` | `process`, `drain` | Specific to debounce queue |
| `sync` | `refresh`, `reload` | Specific to UserCalendar → jobs pipeline |
| `dispatch` | `send`, `deliver` | Specific to job → message pipeline |
| `feature` | `useCase`, `purpose` | LLM usage categorization tag |
| `correlationId` | `traceId`, `requestId` | Pairs LLM calls with triggering events |
| `band` | `score`, `grade` | IELTS scoring terminology |
| `examDate` | `testDate` | Matches UserGoals API field |
| `cadence` | `frequency` | Matches code and type names |
| `postback` | `buttonClick` | Messenger platform terminology |
| `dead letter` | `failed queue` | Standard messaging pattern |
