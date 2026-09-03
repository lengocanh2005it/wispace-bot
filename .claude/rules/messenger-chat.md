---
alwaysApply: false
paths: apps/messenger-bot/src/modules/messenger/application/services/messenger-chat*
---

# Messenger chat queue & shared state (H7 + R4)

Free-form chat: debounce → LLM agent → Send API. Integrates `ChatRateLimitModule` at flush.

## Two queue modes

| Mode                           | Env                                 | Debounce buffer                                |
| ------------------------------ | ----------------------------------- | ---------------------------------------------- |
| Local (1 instance)             | `CHAT_QUEUE_STORE=memory` (default) | In-process RAM (`MessengerChatEnqueueService`) |
| Distributed (≥2 pods or Redis) | `CHAT_QUEUE_STORE=redis`            | Redis `chat:queue:buffer:{psid}`               |

Legacy: `CHAT_QUEUE_SHARED=true` → `CHAT_QUEUE_STORE=redis` when not explicitly set.

`CHAT_QUEUE_STORE=postgres` **removed** (`messenger_chat_queue_buffer` table dropped) — use `redis` for multi-pod.

## Chat queue store (R4)

| Backend | Env                                             | Notes                                                                                                                                      |
| ------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Memory  | `CHAT_QUEUE_STORE=memory` (default)             | 1 pod — wraps `@wispace/chat-queue-core`'s `DebounceChatQueue` (package shared across all bots, see `.claude/rules/clean-architecture.md`) |
| Redis   | `CHAT_QUEUE_STORE=redis` + `REDIS_ENABLED=true` | `chat:queue:buffer:{psid}`, set `chat:queue:active-psids`, lock `chat:queue:lock:{psid}`                                                   |

Port: `CHAT_QUEUE_STORE` → `ChatQueueStoreResolver` (redis when distributed).

## Chat history store (R1)

| Backend | Env                                               | Notes                                                                                                                                     |
| ------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Memory  | `CHAT_HISTORY_STORE=memory` (default)             | 1 pod — wraps `@wispace/chat-history`'s `MemoryChatHistoryStore` (package shared with Discord, see `.claude/rules/clean-architecture.md`) |
| Redis   | `CHAT_HISTORY_STORE=redis` + `REDIS_ENABLED=true` | Key `chat:history:{psid}`, TTL `CHAT_HISTORY_TTL_MS` — Redis store is not in the package (infrastructure-specific to each app)            |

`CHAT_HISTORY_STORE=postgres` **removed** (`messenger_chat_history` table dropped).

Port: `CHAT_HISTORY_STORE` → `ChatHistoryStoreResolver`.

## Webhook ingestion (R2 — durable inbox)

| Concern             | Where                                       | Notes                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persist before ack  | `webhook_inbound_events` (shared table)     | Messenger/Zalo persist every authenticated event before 200; persistence failure → non-2xx → platform redelivers                                                                                                   |
| Idempotency         | Unique `(platform, event_id)`               | Messenger `mid`, Zalo `msg_id`; postbacks/follows use `{type}:{userId}:{timestamp}` — replaces the removed `CHAT_DEDUPE_STORE` memory/Redis stores                                                                 |
| Postback double-tap | Durable unique `(platform, event_id)` index | No process-local debounce; a failed inbox write is retried normally                                                                                                                                                |
| Retry               | Inbound retry cron (30s, advisory-locked)   | `pending`/`failed` rows with bounded backoff → `abandoned` (terminal) after `WEBHOOK_INBOUND_MAX_RETRIES`; stale `processing` rows are terminalized, not replayed, because side effects may already have completed |
| Claim               | `status='processing'` transition            | The retry worker claims before processing; the request path only persists and acknowledges                                                                                                                         |

Port: `PlatformWebhookInboundEventService` (`@wispace/database`) — `ingest` / `claim` / `markCompleted` / `markFailed` / `listDue`.

Distributed enqueue is fail-safe: Redis lock contention, unavailable Redis, or
an append error is surfaced by `RedisChatQueueStore`, retried briefly (3
attempts, 25 ms between attempts), then propagated through
`WebhookActionExecutorService`. The durable webhook inbox marks the event
failed and its 30-second retry cron replays it after Redis recovers; the
webhook must not mark such an event completed.

Every distributed queue worker runs one bounded reconciliation pass per minute
under a platform lock. The buffer JSON is authoritative for active/flush/stuck
indexes; missing indexes are rebuilt, stale indexes are removed, and malformed
or internally inconsistent states are moved to a 24-hour quarantine key and
reported as unresolved for operator follow-up. The pass never replays text or
creates queue state. Reports contain aggregate counts plus at most five masked
external IDs. See [ADR-0007](../../docs/adr/0007-postgres-redis-consistency.md).

## Main files

| File                                                      | Role                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `messenger-chat-queue.service.ts`                         | Enqueue, debounce, flush, `processChatBatch`, reserve hook |
| `messenger-chat-history.service.ts`                       | LLM context facade — delegates to `CHAT_HISTORY_STORE`     |
| `infrastructure/persistence/redis-chat-queue.store.ts`    | Redis queue buffer (R4)                                    |
| `infrastructure/persistence/chat-queue.store.resolver.ts` | Redis store when distributed                               |
| `infrastructure/persistence/*-chat-history.store.ts`      | memory / redis stores (R1)                                 |
| `messenger-chat-shared-config.service.ts`                 | `CHAT_QUEUE_STORE`, `CHAT_QUEUE_SHARED`, TTL, stuck ms     |
| `messenger-chat-queue-worker.service.ts`                  | Cron poll Redis buffer (2s)                                |

Queue port: `CHAT_QUEUE_STORE`. History port: `CHAT_HISTORY_STORE`.

## DB tables (removed)

- `messenger_chat_queue_buffer` — dropped by migration `1717747200010`
- `messenger_chat_history` — dropped by migration `1717747200010`
- `messenger_chat_webhook_seen` — dropped (dedupe is now the durable `webhook_inbound_events` unique index)

## Flush conventions

- Idempotency key = `message.mid` of the **last message** in the debounce batch
- 1 flush = 1 turn (when enforcement is enabled)
- Missing `mid` + enforcement → skip / `CHAT_MISSING_MID` (H5)

## Reschedule via chat

- Tool `reschedule_study_session` does **not** call Wispace immediately — `MessengerRescheduleConfirmationService` stages a pending state + postback button.
- Only when user clicks `CONFIRM_RESCHEDULE` → `StudyCalendarCommandService.rescheduleSession`.
- Postbacks: `CONFIRM_RESCHEDULE` / `CANCEL_RESCHEDULE` in `messenger.service.ts`.

## In-chat privacy confirm (#660)

- `MessengerChatProcessorService.processChatBatchInner` checks privacy **before** the quota block: `privacyState.getPendingAction(psid, 'messenger')` + `detectPrivacyIntent(mergedText)`. If either is truthy → `handlePrivacyIntent` → `return true` (no quota slot, no `pipeline.flush`).
- **Intercept-all while pending:** once a pending action exists, every message routes to the handler — bare `Có`/synonym executes, bare `Không`/synonym cancels, anything else re-sends the `Có/Không` reminder. `isConfirmationResponse` / `isCancellationResponse` are anchored (`^…$`); a merged/multi-line reply is treated as "neither" → reminder.
- Inbound consent/cancel is logged to `message_logs` as `PRIVACY_CONFIRM_IN` / `PRIVACY_CANCEL_IN` before the irreversible step (`logPrivacyInbound`, best-effort).
- `PrivacyStateService` TTL is `PRIVACY_CONFIRM_TTL_MS` (default 30 min), read via `MessengerChatSharedConfigService.getPrivacyConfirmTtlMs()` and passed to the constructor by the `useFactory` in `chat-pipeline.module.ts`. In-memory + pod-local — durable/cross-pod persistence is #542.

## Tests

- `messenger-chat-queue.service.spec.ts`
- `messenger-chat-queue.service.shared.spec.ts`
- `redis-chat-queue.store.spec.ts`
- `messenger-chat-history.service.spec.ts`

## Related

- Quota logic: `.claude/rules/chat-rate-limit.md`
- Docs: `apps/messenger-bot/docs/chat-rate-limit-quota.md` §5.3, H7
