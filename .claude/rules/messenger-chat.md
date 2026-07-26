---
alwaysApply: false
paths: apps/messenger-bot/src/modules/messenger/application/services/messenger-chat*
---

# Messenger chat queue & shared state (H7 + R4)

Free-form chat: debounce → LLM agent → Send API. Integrates `ChatRateLimitModule` at flush.

## Two queue modes

| Mode | Env | Debounce buffer |
|------|-----|-----------------|
| Local (POC 1 instance) | `CHAT_QUEUE_STORE=memory` (default) | In-process RAM (`MessengerChatQueueService`) |
| Distributed (≥2 pods or Redis) | `CHAT_QUEUE_STORE=redis` | Redis `chat:queue:buffer:{psid}` |

Legacy: `CHAT_QUEUE_SHARED=true` → `CHAT_QUEUE_STORE=redis` when not explicitly set.

`CHAT_QUEUE_STORE=postgres` **removed** (`messenger_chat_queue_buffer` table dropped) — use `redis` for multi-pod.

## Chat queue store (R4)

| Backend | Env | Notes |
|---------|-----|-------|
| Memory | `CHAT_QUEUE_STORE=memory` (default) | 1 pod POC — wraps `@wispace/chat-queue-core`'s `DebounceChatQueue` (package shared across all bots, see `.claude/rules/clean-architecture.md`) |
| Redis | `CHAT_QUEUE_STORE=redis` + `REDIS_ENABLED=true` | `chat:queue:buffer:{psid}`, set `chat:queue:active-psids`, lock `chat:queue:lock:{psid}` |

Port: `CHAT_QUEUE_STORE` → `ChatQueueStoreResolver` (redis when distributed).

## Chat history store (R1)

| Backend | Env | Notes |
|---------|-----|-------|
| Memory | `CHAT_HISTORY_STORE=memory` (default) | 1 pod POC — wraps `@wispace/chat-history`'s `MemoryChatHistoryStore` (package shared with Discord, see `.claude/rules/clean-architecture.md`) |
| Redis | `CHAT_HISTORY_STORE=redis` + `REDIS_ENABLED=true` | Key `chat:history:{psid}`, TTL `CHAT_HISTORY_TTL_MS` — Redis store is not in the package (infrastructure-specific to each app) |

`CHAT_HISTORY_STORE=postgres` **removed** (`messenger_chat_history` table dropped).

Port: `CHAT_HISTORY_STORE` → `ChatHistoryStoreResolver`.

## Webhook dedupe store (R2)

| Backend | Env | Notes |
|---------|-----|-------|
| Memory | `CHAT_DEDUPE_STORE=memory` (default) | `message.mid` + postback 15s in RAM |
| Redis | `CHAT_DEDUPE_STORE=redis` + `REDIS_ENABLED=true` | `dedupe:mid:{mid}`, `dedupe:postback:{psid}:{payload}` |

`CHAT_DEDUPE_STORE=postgres` **removed** (`messenger_chat_webhook_seen` table dropped) — use `redis` for multi-pod.

Port: `CHAT_DEDUPE_STORE` → `WebhookDedupeStoreResolver` — `MessengerService` no longer has internal Map dedupe.

## Main files

| File | Role |
|------|------|
| `messenger-chat-queue.service.ts` | Enqueue, debounce, flush, `processChatBatch`, reserve hook |
| `messenger-chat-history.service.ts` | LLM context facade — delegates to `CHAT_HISTORY_STORE` |
| `infrastructure/persistence/redis-chat-queue.store.ts` | Redis queue buffer (R4) |
| `infrastructure/persistence/chat-queue.store.resolver.ts` | Redis store when distributed |
| `infrastructure/persistence/*-chat-history.store.ts` | memory / redis stores (R1) |
| `infrastructure/persistence/*-webhook-dedupe.store.ts` | memory / redis dedupe (R2) |
| `messenger-chat-shared-config.service.ts` | `CHAT_QUEUE_STORE`, `CHAT_QUEUE_SHARED`, TTL, stuck ms |
| `messenger-chat-queue-worker.service.ts` | Cron poll Redis buffer (2s) |

Queue port: `CHAT_QUEUE_STORE`. History port: `CHAT_HISTORY_STORE`.

## DB tables (removed)

- `messenger_chat_queue_buffer` — dropped by migration `1717747200010`
- `messenger_chat_history` — dropped by migration `1717747200010`
- Webhook dedupe `mid` — Redis (`CHAT_DEDUPE_STORE=redis`) or RAM; **no** DB table remains

## Flush conventions

- Idempotency key = `message.mid` of the **last message** in the debounce batch
- 1 flush = 1 turn (when enforcement is enabled)
- Missing `mid` + enforcement → skip / `CHAT_MISSING_MID` (H5)

## Reschedule via chat

- Tool `reschedule_study_session` does **not** call Wispace immediately — `MessengerRescheduleConfirmationService` stages a pending state + postback button.
- Only when user clicks `CONFIRM_RESCHEDULE` → `StudyCalendarCommandService.rescheduleSession`.
- Postbacks: `CONFIRM_RESCHEDULE` / `CANCEL_RESCHEDULE` in `messenger.service.ts`.

## Tests

- `messenger-chat-queue.service.spec.ts`
- `messenger-chat-queue.service.shared.spec.ts`
- `redis-chat-queue.store.spec.ts`
- `messenger-chat-history.service.spec.ts`

## Related

- Quota logic: `.claude/rules/chat-rate-limit.md`
- Docs: `apps/messenger-bot/docs/chat-rate-limit-quota.md` §5.3, H7
