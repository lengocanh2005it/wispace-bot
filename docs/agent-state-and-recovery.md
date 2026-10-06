# State, claims, and recovery

Everything that survives a pod restart: who owns a row, how work is claimed and
handed back, what a crash leaves behind, and what a learner's deletion must
clean up. Flow and schedule detail for each area also lives in
`docs/project-overview.md` §6 (crons) and §5 (HTTP), and in
`.claude/rules/study-reminder.md`.

## Advisory lock registry

Ids are registered in `ADVISORY_LOCKS` (`@wispace/bot-common`); a new cron takes
its id from there. Contention is log-and-skip, never a queue behind the lock.

| Id                                                                  | Lock name                                     | Scope                                                           |
| ------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `884_200_801` / `802` / `803`                                       | report cron leader, lease `report:<platform>` | per platform (Messenger / Discord / Zalo)                       |
| `884_200_901/902/903`, `884_200_944/945/946`, `884_200_947/948/949` | study-reminder sync / cleanup / rollover      | per platform — `.claude/rules/study-reminder.md`                |
| `884_200_905` / `884_200_932`                                       | `MESSENGER_/ZALO_WEBHOOK_INBOUND_RETRY`       | per platform, every 30s                                         |
| `884_200_910` / `884_200_933`                                       | `MESSENGER_/ZALO_WEBHOOK_INBOUND_CLEANUP`     | per platform, 03:15 ICT                                         |
| `884_200_934`                                                       | `DISCORD_LINK_RECONCILE`                      | Discord, every 5 min                                            |
| `884_200_937`                                                       | `ZALO_LINK_RECONCILE`                         | Zalo, every 5 min                                               |
| `884_200_943`                                                       | `DATA_QUALITY_CHECK`                          | deliberately fleet-wide — unrelated to the per-platform ids     |
| `884_200_950`                                                       | `DISCORD_REENGAGEMENT`                        | Discord batch scan                                              |
| `884_200_951`                                                       | `DISCORD_REPORT_RETRY_DISPATCH`               | Discord, every 15 min                                           |
| `884_200_952`                                                       | `RESCHEDULE_RECOVERY`                         | **global**, shared by all three bots (see platform scope below) |

A lock skip is observable: `study_reminder_lock_skips_total{platform,scope}` for
the reminder worker, a debug log for the retry-dispatch and reschedule crons.

## Lease ownership and stuck recovery

`claimJob` assigns a `lease_token` + `lease_expires_at`
(`STUDY_REMINDER_LEASE_MS` / `REPORT_SEND_LEASE_MS`, default 10 min).
`markSent` / `markFailed` / `markCancelled` require that token, so a stale worker
no-ops instead of overwriting the new owner's state. Stuck-processing recovery
reopens **expired leases only** (migration `1751029200018` backfills in-flight
rows).

Scheduled-report claims work the same way with a UUID lease token. Existing
claimed rows whose lease fields are null use `updated_at` as the recovery cutoff.
A released claim is reclaimable on the next claim (`ON CONFLICT DO UPDATE …
WHERE status='released'`); a `sent` claim is never reclaimable.

**Invariant: lease < stuck threshold.** `resetStuckProcessingJobs` uses
`2 × leaseMs` so a slow send is not reclaimed before its own `markSent` (#521).

Cron leader election rides on `CRON_LEADER_ENABLED` + leases in `cron_leader_leases`
refreshed by `cron-leader-heartbeat`; report work additionally claims rows, so
leader election alone is not the correctness mechanism.

## Durable inbound inbox

Flow, config and the `(platform, event_id)` idempotency contract:
`docs/project-overview.md` §5 "Webhook ingestion semantics". The state rules:

- every authenticated event is persisted **before** the endpoint acks; a
  persistence failure returns non-2xx and the platform redelivers;
- a claim assigns a `lease_token` (migration `1786869155627`) and
  `markCompleted` / `markFailed` / `markProcessingAbandoned` require it, so a
  worker whose lease was recovered no-ops instead of overwriting terminal state
  (#149);
- a stale `processing` lease is **terminalized, not replayed** — its side effects
  may already have completed. The scan is indexed by `(platform, status,
updated_at)` (migration `1751029200017`);
- `abandoned` is terminal after `WEBHOOK_INBOUND_MAX_RETRIES`;
- replayed events are re-validated against the presentation DTO and mapped
  through an explicit field-copy mapper (`apps/*/presentation/mappers/`): unknown
  fields are stripped, wrong types fail into the normal retry/backoff path (#436);
- a webhook-action `send_text` is awaited before the inbox marks the event
  completed, so a Meta delivery failure propagates and the retry cron replays the
  event.

Retention: the cleanup cron deletes only terminal rows older than
`WEBHOOK_INBOUND_RETENTION_DAYS` (default 30); non-terminal rows keep retry and
recovery working.

## Link verify intents

A verified single-use token is spent before the local mapping is committed, so
the mapping write is fenced by a durable intent row.

**Discord** — `DiscordLinkCompletionService` (application layer; the controller
only redirects) runs verify token → persist verify intent
(`discord_link_verify_records`, durable outbox #137) → `upsertLink` (retried,
because WISPACE has already consumed the token) → relink notice →
membership/welcome check → consume the intent only after the post-commit work
succeeds. Bounded membership retries distinguish Discord `Unknown Member` code
`10007` (confirmed non-member) from an ambiguous API error (#484); an ambiguous
failure leaves the intent for reconciliation. Verify intents store an intent
generation and the pre-verify mapping observation, and callback/reconcile upserts
use a compare-and-set fence so the first successful commit wins and stale intents
are retired. Migration `1789093200000` removes legacy intents that have no
trustworthy observation. Cron `discord-link-reconcile` (5 min, lock
`884_200_934`, env `DISCORD_LINK_RECONCILE_AGE_MS` /
`DISCORD_LINK_RECONCILE_MAX_AGE_MS`) re-commits a missing mapping and consumes the
intent only after membership and any due welcome processing succeed.

**Welcome dedupe (#231/#232/#233/#159)** — `discord_welcome_records` (PK
`discord_user_id`, `last_welcomed_at`, `source` organic|linked,
`claim_expires_at`) is the single dedupe state for both paths, so an organic join
followed by a link inside the window yields exactly one DM. `sendMenuButtons`
returns a boolean and the welcome is marked only when the send was acknowledged —
a failed send leaves the record unwelcomed for the next event to retry.
`tryClaimWelcome` is an atomic claim (one conditional upsert: wins when never
welcomed, past the window, or holding an expired claim), so a concurrent OAuth
callback and `guildMemberAdd` send at most once; `DISCORD_WELCOME_CLAIM_MS`
(default 60s) makes a crashed sender's claim reclaimable. `DISCORD_GUILD_ID` unset
fails closed in `isMember` (returns false), so the callback defers the welcome to
`guildMemberAdd`. `onGuildMemberAdd` wraps the whole handler in try/catch (nested
for the channel welcome) and always writes its summary log (#234); counter
`discord_welcome_attempts_total{outcome=success|error|skipped}`. An unlinked user
gets the organic welcome unless a fresh pending verify intent exists
(`DISCORD_LINK_PENDING_ORGANIC_SKIP_MS`, default 120s — the callback owns that
welcome). A relink (same Discord ID, different WISPACE user) sends a
`DiscordRelinkNotifier` DM and a warn log, by design; a blocked DM increments
`discord_dm_delivery_failures_total{reason}`. The OAuth redirect always carries
`Referrer-Policy: no-referrer` and lands on `DISCORD_LINK_LANDING_URL`.

**Zalo** (#147, mirror of Discord #137) — `ZaloLinkCompletionService` verifies the
token, persists the intent (`zalo_link_verify_records`, migration `1786890667352`)
**before** the local `upsertLink` (bounded retries, because the token is already
consumed), consumes the intent fire-and-forget, sends a deduped linked welcome,
and emits the relink notice after the mapping is committed. Same intent
generation + compare-and-set fence; the same migration `1789093200000` applies.
Cron `zalo-link-reconcile` (5 min, lock `884_200_937`, env
`ZALO_LINK_RECONCILE_AGE_MS` / `ZALO_LINK_RECONCILE_MAX_AGE_MS`) re-commits pending
intents idempotently, and `zalo_welcome_records` holds the atomic claim lease.

Zalo interactive tools send the **inbound Zalo OA id** in `x-zaloid`
(`wispaceExternalId: (ctx) => ctx.externalUserId`); the internal WISPACE `userId`
stays local.

## Report wave: claims, retry dispatch, capacity

The 08:00 ICT wave combines claim table, advisory lock and leader election. Its
operational completion target is 09:00 ICT, separate from the rolling 99%
delivery SLO (`docs/slo-catalog.md`).

Discord retry dispatch (#521) runs every 15 minutes behind
`ReportCronLeaderService` and lock `884_200_951`, at parity with the Messenger
twin. **Every orchestration outcome writes terminal-or-deferred state**: a
skipped claim is requeued without consuming a retry (the claim owner is still
alive), a deferred outcome becomes `markFailed` plus a future `next_retry_at`, and
a closed window expires terminally — so no job sits in `processing` waiting for
stuck-reset churn. Backoff writes go through `reportRetryAt`
(`@wispace/scheduler-core/utils`).

**Background producer capacity (#1363).** Capacity is
`min(slots + maxQueueDepth, slots + floor(backgroundWaitMs × slots /
requestTimeoutMs))`; with the documented defaults that is
`3 + floor(1500 × 3 / 30000) = 3`. Report and reminder producers derive their
default concurrency from this local capacity, and an explicit producer value above
it fails startup rather than being clamped. `LLM_EXECUTION_ENABLED=false` stays an
uncontrolled passthrough and logs that the producer cap is not enforced.
Redis-global mode is not claimed to be fleet-fair until #867; mixed chat fairness
is #580. A capacity overload happens **before** the provider call, so it consumes
no tokens, and durable report retries carry a bounded `retry_cause=capacity_overload`.
The implementation exposes `llm_background_admission_total`,
`llm_overload_regenerations_total` and `report_wave_completion_lag_seconds` with
bounded labels and no `day` label.

## Reschedule

**Create before delete.** The replacement slot is created first (idempotent — an
existing target slot is reused on a retry), then the source is deleted with
bounded retries, so a failure never leaves the learner without a session.
Confirmation staging uses a guarded
`INSERT … ON CONFLICT … WHERE status <> 'processing'` and returns a conflict
instead of overwriting an in-flight row; cancellation is external-id-scoped and
claimed cleanup requires the exact lease, so stale recovery cannot delete a
replacement.

**Approval token required by type (#1493, ADR-0011).** A staged reschedule is
committed only by a button/postback carrying its one-time approval token — the
same value named `nonce` on the pending record, `confirmationToken` in an emitter
and `approvalToken` in the service. The token is required at
`PlatformAgentToolsOptions.reschedule.confirmSender`,
`DiscordOutboundService.sendRescheduleConfirmation`,
`buildRescheduleConfirmFollowUp`, and the Messenger `confirm_reschedule` /
`cancel_reschedule` router actions. Discord routes both actions through the single
`interactionCreate` listener (no `@Button` binding).
`bash .github/scripts/check-reschedule-confirm-handlers.sh` (CI
`deploy-scripts-test`) fails the build on a fixed-id `@Button` binding, a bare
postback comparison, or a re-optionalised token. Out of scope by design: a
token-less **text** cancel and `RescheduleConfirmationService.cancel()`'s optional
token (cancelling a staged proposal is not a calendar write), and
`StageResult.confirmationToken`, which stays optional because it is
non-enumerable and must stay out of legacy response shapes.

Shared Discord/Zalo staging (#1062) forwards the optional caller `AbortSignal`
through calendar lookup and pending save. Before confirmation delivery, an
internal abort sends no prompt and cleans only the matching approval token/nonce;
a token-less stage fails closed; cleanup is bounded and sanitised. After outbound
delivery starts, existing semantics remain authoritative.

**Mutation proof (#1418).** `reschedule_confirmation_attempts` is an append-only
record keyed `(platform, external_id, nonce)` — the nonce _is_ the approval
token. `status='attempting'` means an unknown outcome, so the calendar write is
never re-run or re-armed (it is not idempotent). `confirm()` runs
`beginAttempt` → calendar write → `confirmAttempt` → `cancelClaimed`, where the
cleanup sits **outside** the write's try (if it fails, recovery cleans up; the
commit is not reverted) → exactly one text; every `OutboundDeliveryOutcome` is
written. A replay or double tap reads the record and returns the confirmation
again. The `reschedule-recovery` cron consults the record **before** re-arming: no
record → re-arm is safe; `attempting` → cancel and alert; `confirmed` → clean the
row only. The same cron retries a confirmation that was deferred (bounded 5
attempts; `ambiguous` is never retried) over that platform's transport.
Messenger reads the record; Discord and Zalo are tracked in #1483.

**Platform scope (#1507).** The attempts table and the `RESCHEDULE_RECOVERY` lock
are global, while each bot replays only its own rows:
`TypeormRescheduleAttemptStore` binds `platform` at construction (like
`TypeormRescheduleStore`) and `listDueNotificationAttempts` filters on it, and
`beginAttempt` takes no `platform` argument — a caller-supplied value could
disagree with the store and write a row into another platform's scan scope. Index
`idx_reschedule_attempt_platform_due (platform, status, notification_status,
next_notification_attempt_at)` (migration `1789094100000`) replaces the previous
index without `platform`; a new predicate on the old index stays a seq-scan. All
three bots bind a transport — `deliver({ externalId, scheduledTimeLabel, userId })`
→ `sendTextViaPsid` / `DiscordOutboundService.sendText` /
`ZaloOutboundService.sendText` — and `userId` is required so a replay loads the
same outbound bucket as the first send (#1494). Because the lock is shared, each
tick replays exactly one platform, whichever pod wins; a row waits for a tick its
own bot wins. Wiring specs read the binding Nest resolves with
`findEffectiveFactoryProvider`, so deleting an override fails them.

## Cached reads and invalidation

All cached WISPACE reads (goals, calendar, score averages) go through the single
`WispaceDataCache` in `@wispace/wispace-client`. TTLs live **only** in
`WISPACE_CACHE_POLICY` (goals 60s, calendar 15s, scores 5min): a new cached read
adds a kind there rather than picking a TTL of its own. The cache key is
`kind + externalUserId + canonical args` (signal excluded).

Write-invalidation is explicit: a `precreate_next_exercise` success calls
`cacheInvalidation.invalidateGoals` (chat-agent `WispaceCacheInvalidationPort`),
and the shared `@wispace/reschedule-confirm` mutation boundary invokes an optional
`CalendarCacheInvalidationPort.invalidateCalendar` only after the reschedule write
and claim cleanup — staging does not invalidate. Discord/Zalo pass their existing
adapters; Messenger has no calendar cache. Cached-goals consumers call
`WispaceDataCache.getOrFetch('goals', externalUserId, undefined, () =>
goalsService.getUserGoals(...))` directly. Score averages stay passthrough in
report paths, so report freshness is unchanged.

Stampede protection (#568): concurrent misses share one in-flight fetch per key,
and failures are not cached so the next caller retries. With Redis enabled,
Discord/Zalo wire a `RedisWispaceCacheStore` so pods coordinate one upstream fetch
through a token-scoped lock (5s lease) with a mandatory second check after the
grant, a bounded 2s waiter budget (then fail-open local fetch), ±10% shared-TTL
jitter, a date-safe envelope codec, and every shared operation failing soft — Redis
off or down simply means the per-pod cache.

## Chat-session state

Redis command/connection deadlines, TLS and readiness rules are
`docs/project-overview.md` §8 (R0). R5 caches `cache:user:display:{userId}`
(`USER_DISPLAY_NAME_CACHE_*`) before querying the `users` table / `"Users"` view.

**Chat history (R1).** `CHAT_HISTORY_STORE=redis` (requires `REDIS_ENABLED=true`)
or `memory` — the postgres table is gone. Fail-closed: a configured Redis that is
unavailable at startup makes all three bots throw rather than silently degrade to
memory; a runtime blip after a good boot still falls back and logs `ERROR` each
time. Redis appends are atomic per user (#148): `RedisChatHistoryStore` writes
through one Lua script (`eval` — read + append + trim + `SET EX` sliding TTL in a
single server-side step), so concurrent requests for one user cannot lose a turn.
The memory backend is bounded by a 60s sweep timer that enforces TTL expiry, a
global user cap (`CHAT_HISTORY_MAX_USERS` / `ZALO_CHAT_HISTORY_MAX_USERS`, default
10 000, oldest-updated evicted) and a pending tool-summary TTL/cap of 10 per user;
reads and writes never scan the full map (#132).

**Burst counter (R3).** `CHAT_BURST_STORE=redis|postgres`, default `postgres`. The
`memory` backend was retired (#1288) once Redis was provisioned everywhere. An
unrecognised value — including a leftover `=memory` — falls back to `postgres`,
which stays the correctness floor (ADR-0007), and that fallback is not silent in
production: `ChatRateLimitStartupService` throws at startup under
`isStrictProductionRuntime` when the configured value is not a supported store,
reusing the H1 quota gate and its exception, so a stale Vault value cannot be
inherited unnoticed. Unset is not unsupported. `chat-metering`'s `core` surface
does not re-export `MemoryBurstCounter`, and `boundaries.spec.ts` fails the build
if it returns.

**Chat queue (R4/#174).** `CHAT_QUEUE_STORE=redis|memory` — the debounce buffer;
`CHAT_QUEUE_SHARED=true` maps to `redis` (H7 legacy alias). Production requires
Redis on all three bots. Messenger keeps the legacy `chat:queue:*` keys while
Discord/Zalo use `chat:queue:<platform>:*`. A common 2s poller uses bounded
due-time ZSET reads and per-user locks, and legacy Messenger active members are
rehydrated once behind a short Redis lock after a deploy (#126).
`CHAT_MAX_PENDING_MESSAGES` (0 = no cap) bounds messages queued while the bot is
processing (Discord/Zalo); over the cap the oldest is dropped and exactly one
"Bạn gửi hơi nhiều tin quá..." notice is sent per processing round
(`onPendingDropped` / `droppedNoticePending` on Redis), on all three bots.
Messenger's and Zalo's durable inbox completion waits for the Redis enqueue write,
and delivery stays at-least-once after a worker crash. Flush-retry backoff is the
one retry path not yet jittered (#1345; inventory in `docs/project-overview.md`
§7.1.1).

**Outbound sends (#156).** Discord/Zalo retry rate limits, 5xx and explicit network
failures; a known 4xx/auth/validation error fails fast. Discord retries reuse a
stable `nonce` with `enforceNonce=true`; the current Zalo payload has no
equivalent idempotency field. Timeout and other ambiguous outcomes are not
retried and increment `dm_send_ambiguous`. The per-learner backstop
(`OutboundRateLimiter`) makes a breach a terminal `rate_limited` outcome: chat
refunds its inbound quota, while reminders, reports and dead-letter replay treat
it as terminal (`docs/outbound-rate-limit.md`). Send-API breaker accounting (#517)
and Zalo specifics are `docs/project-overview.md` §7.1 and
`apps/zalo-bot/docs/zalo-outbound-delivery.md`.

## Re-engagement (#850/#853/#854)

`POST /v1/discord/reengagement/run-once` (ops-guarded, body `{ userId }`) is
mapping lookup via `DiscordAccountLinkService` — the id comes from the mapping,
not the payload — then `ReengagementApiClient.getPayload` →
`DiscordOutboundService.sendProactivePayload` → `markSent`. The web-activity
dormancy gate (#595) is not part of this path: a dormant learner is a valid
recipient. The #596 consent filter belongs to the batch scan, where it is applied
bot-side via `NotificationPreferenceService.findReportOptedInUserIds` (the
preference table lives in the bot database, so the backend cannot filter it). An
ambiguous send marks SUCCESS, which is the anti-duplicate choice. Metric:
`discord_reengagement_send_total{outcome}`.

Cron `discord-reengagement-cron`: gated by `REENGAGEMENT_ENABLED` (default off),
advisory lock `DISCORD_REENGAGEMENT` `884_200_950` (contention logs and skips),
one page of `getCandidates` (no cursor; ceiling `REENGAGEMENT_MAX_PER_BATCH`),
`REENGAGEMENT_SEND_GAP_MS` between sends, `REENGAGEMENT_DRY_RUN` = scan only, and
one failure does not stop the batch. Dedupe authority is backend suppression, not
local sent-state.

## Recovery and retention crons

- `chat-quota-stuck-recovery` (5 min, advisory-locked) refunds quota slots stuck
  `reserved` past `CHAT_IDEMPOTENCY_STUCK_RESERVED_MS`; linked rows decrement by
  `(platform, user_id, external_user_id, usage_date)`, anonymous rows by
  `(platform, external_user_id, usage_date)`.
- `report-claims-stale-reset` (30 min, advisory-locked) releases expired
  per-platform and learner-level scheduled-report leases on all three bots.
- `messenger-message-log-cleanup` — 03:00 ICT Mondays,
  `MESSENGER_MESSAGE_LOG_RETENTION_DAYS=90`
  (`MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED=false` disables).
- `${platform}-report-claims-cleanup` — 03:45 ICT, 90 days.
- `privacy-cleanup-reconcile` — every 5 min, own-platform only —
  `docs/privacy-erasure-verification.md`.
- Dead-letter replay covers **outbound** failures only
  (`webhook_dead_letters.direction`, migration `1751029200011`); Messenger's
  inbound dead-letter flow was replaced by the durable inbox. Dead-letter
  persistence retries bounded (3×) and returns `false` on failure, so callers log
  "no durable recovery record" rather than treating the send as handled.

## What a learner's deletion must remove

`PrivacyDataService`
(`packages/database/src/services/metering-and-operations/privacy-data.service.ts`).
Every operation is idempotent, so calling one twice is safe. The erasure below is
atomic via `dataSource.transaction()`:

| Store                                                                     | Erased by                                                                               | Method          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------- |
| `user_platform_mappings` / `discord_account_links` / `zalo_account_links` | `unlink()`                                                                              | `repo.remove()` |
| `learner_profiles`                                                        | `delete()` by `userId`                                                                  | `repo.delete()` |
| `study_reminder_jobs`                                                     | `delete()` by `userId`                                                                  | `repo.delete()` |
| `scheduled_report_claims`                                                 | `delete()` by `userId`                                                                  | `repo.delete()` |
| `report_send_jobs`                                                        | `delete()` by `userId`                                                                  | `repo.delete()` |
| `chat_daily_usage`                                                        | `delete()` by `userId`; `user_id IS NULL` only when the mapping has no `userId` (#1177) | `repo.delete()` |
| `llm_usage_events`                                                        | `delete()` by `userId`                                                                  | `repo.delete()` |
| `chat_idempotency`                                                        | `delete()` by `userId`                                                                  | `repo.delete()` |
| `user_notification_preferences` (consent state #596)                      | `delete()` by `userId`                                                                  | `repo.delete()` |
| Redis chat history                                                        | `delete()` via per-call `PrivacyStateCleanup`                                           | `redis.del()`   |

Preserved as audit trail, auto-cleaned by the retention crons above:
`message_logs` (90 days), `webhook_inbound_events` (30 days, terminal rows),
`webhook_dead_letters` (30 days), `discord`/`zalo_link_verify_records` (reconcile
cron), `discord_welcome_records` / `zalo_welcome_records` (dedupe state, no PII),
`scheduled_report_claims` + `learner_scheduled_report_claims` (report
audit/claim state). Not erasable: `chat_quota_events` stores `aggregate_id`, not an
external id.

Delete is keyed by the WISPACE `user_id` (the root identifier), so deleting via
Messenger also removes Discord/Zalo records.

The four platform-owned Redis/state stores (`chat_history`, `chat_queue`,
`clarification_state`, and Messenger's `display_name_cache`) are represented by
durable `privacy_cleanup_jobs` created in the same transaction. Request-time
cleanup makes three bounded attempts per store and answers `status: complete` or
`status: incomplete` with an opaque `cleanupId` and `outstandingStores`;
incomplete is HTTP 202, a generation conflict is 409. Each bot reconciles only its
own platform jobs every five minutes (at most 100 jobs, 60-second lease), fences
relinks, and retains completed/stale jobs for seven days ([ADR-0014](adr/0014-privacy-erasure-completion.md)).

**Entity registration.** Each app's `DatabaseModule` exports
`buildPrivacyEntityRegistry()` and provides `PrivacyDataService` with its result —
an explicit `PrivacyEntityRegistry` holding all three mapping entity classes, the
scoped entity targets, and that app's message-log entity.
`npm run database:privacy-smoke` calls those same exported builders, so the smoke
exercises the registry the app really wires rather than a copy that can drift. The
constructor checks `DataSource.hasMetadata()` for every target and fails startup
naming the missing target. Mapping entities are canonical exports from
`@wispace/database` and are included in the shared TypeORM options; app-local
entity paths re-export them for existing consumers. Calls are scoped to the app's
configured platform.

**Redis cleanup.** Each bot's ops controller (and Messenger's in-chat privacy-intent
path) wires per-call `PrivacyStateCleanup` callbacks on every `unlink()` /
`delete()`, using the app's own services: `clearHistory` via
`PlatformChatHistoryService.clear`, `clearQueuedWork` via the chat-queue service's
`clearChatBuffer` (per-user `srem`/`zrem` on the shared active/flush/stuck sets,
never a bulk `DEL` of them), `clearClarification` via the agent's clarification
clearer, and `clearUserCache` (Messenger only — Discord/Zalo have no display-name
cache) via `RedisUserDisplayNameCache.delStrict(userId)` on the durable privacy
path; `del()` stays best-effort for non-privacy callers. Callbacks clear only
this app's platform keys — cross-platform Redis erasure happens when the backend
calls each bot's `/privacy/delete` endpoint (idempotent), and calling one
platform's callbacks with another platform's id is a safe no-op (#537), because
key shapes never collide across platforms. Durable jobs make a failure retryable
after the request; memory-mode history clears only the local pod. The dequeue
race (an in-flight turn replying after erasure) is accepted — the window is
sub-second. The real fleet drill is `npm run database:privacy-erasure-drill`
(`docs/privacy-erasure-verification.md`).

## Runtime surfaces

**Readiness.** `/health`, `/health/ready`, `/health/detail` semantics are
`docs/project-overview.md` §5. Platform readiness is cached inside each container
and performs no vendor call inside the probe: Discord reads gateway lifecycle
state plus a 60s reconnect grace (`DISCORD_READINESS_RECONNECT_GRACE_MS`),
Messenger uses startup plus 5-minute read-only Graph validation with outbound
token signals (`MESSENGER_PLATFORM_HEALTH_CHECK_INTERVAL_MS` /
`MESSENGER_PLATFORM_HEALTH_STALE_MS`), and Zalo follows the OA token refresh
lifecycle. Missing platform state fails closed.

**`not_configured` vs `unavailable`** (`PlatformConnectivityStatus` in
`@wispace/bot-common/health`): a platform with no upstream cannot be unreachable,
so it reports `not_configured` and does not fail readiness — otherwise the deploy
rolls back forever for a feature that was never switched on. `ZALO_PLATFORM_ENABLED=false`
(Vault `secret/data/wispace-bots/zalo/prd`) is the explicit opt-out, checked in
`markUnavailable`, so it holds whichever way the token flow failed (missing row,
expired row, rejected refresh). Unset or `true` keeps the fail-closed behaviour,
so a broken OA token on a provisioned account still fails readiness.
`not_configured` surfaces in `/health/detail` and raises a `warn`-level
`PLATFORM_NOT_CONFIGURED` ops alert — never silence.

**Graceful shutdown.** `drain()` waits for in-flight debounce flushes, so promoted
pending messages are delivered rather than lost; enqueues arriving after shutdown
are rejected with a notice. All three bots use
`GRACEFUL_SHUTDOWN_TIMEOUT_MS=45s`, which covers 35s of LLM tool execution plus the
drain.
