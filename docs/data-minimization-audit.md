# Data minimization audit (#640)

Audit of persisted personal/sensitive fields across shared and app-local
entities. Verdicts: **keep** (with reason) / **truncate** / **hash** /
**drop**. Implemented changes ship with migrations + tests; larger changes
are filed as follow-ups.

Last updated: 2026-08-31 (#640).

## Verdicts

### `chat_quota_events`

| Field | Verdict | Notes |
| --- | --- | --- |
| `aggregate_id` | **hash** | Stored raw PSID (#541). Now SHA-256 hex (`hashExternalId` from `@wispace/bot-common/masking`): linked events hash the canonical WISPACE `userId`; anonymous events hash the platform external id. Legacy rows may still contain PSID hashes until replay; equality queries hash the matching identity before filtering (see `chat-quota-rebuild.mjs`). |
| `payload.idempotency_key` | **keep** | Message id, not a user id; needed to correlate quota events with `chat_idempotency` during ops recovery. |
| `user_id` | **keep** | WISPACE numeric id — key for joins, erased by `PrivacyDataService` in linked tables; not enough on its own to identify a platform user. |

### `webhook_inbound_events`

| Field | Verdict | Notes |
| --- | --- | --- |
| `raw_payload` | **keep** | Needed for replay/recovery; intentionally intact per `packages/database` notes. Bounded by retention (`WEBHOOK_INBOUND_RETENTION_DAYS`, default 30) — terminal rows are cleaned. Drop-on-terminal → follow-up under #557. |
| `last_error` | **truncate** | Bounded at write time by `truncatePersistedError` (default 2000 chars, `PERSISTED_ERROR_MAX_CHARS` override) in `PlatformWebhookInboundEventService`. |

### `webhook_dead_letters`

| Field | Verdict | Notes |
| --- | --- | --- |
| `raw_payload` | **keep** | Required for outbound replay (#291). Bounded by the shared dead-letter retention/cleanup. |
| `error_message` | **truncate** | Bounded at write time by `truncatePersistedError` in `PlatformDeadLetterService` (`save`/`markAbandoned`/`incrementRetry`). |

### `report_send_jobs` (Messenger + shared outbox)

| Field | Verdict | Notes |
| --- | --- | --- |
| `last_error` | **truncate** | Bounded at write time in both `ReportSendJobRepository` implementations (Messenger + Discord — create + `markFailed`). |

### `study_reminder_jobs`

| Field | Verdict | Notes |
| --- | --- | --- |
| `last_error` | **truncate** | Bounded at write time in `TypeormStudyReminderJobRepository.markFailed`/`markCancelled` (shared by all platforms). |

### Message logs (`message_logs`, Discord/Zalo message logs)

| Field | Verdict | Notes |
| --- | --- | --- |
| `error_message` / `error` | **truncate** | Bounded at write time: Messenger via `MessengerRepository.logMessage`, Discord/Zalo via shared `DeliveryLogService`. |
| `message_text` | **drop (done)** | Already dropped from `message_logs` (migration `1786920000001-DropMessageLogsMessageTextColumn`). |

### `llm_usage_events` / `llm_safety_events`

| Field | Verdict | Notes |
| --- | --- | --- |
| `external_user_id` | **keep** | Required for erasure joins via `PrivacyDataService`; no query works without it. |
| safety text | **keep (already redacted)** | Redacted at write by `redact-safety-text.ts` (#610). |

### Other

| Field | Verdict | Notes |
| --- | --- | --- |
| Correlation ids (`delivery_key`, `lease_token`, `event_id`) | **keep** | Opaque system-generated values; not personal data. `event_id` may embed a PSID for synthetic events — masked only in logs (`maskEventId`); DB column stays intact because dedupe depends on it. |
| Derived data | **keep** | `chat_daily_usage.free_form_count` is derived but rebuildable only from `chat_quota_events`; keeping it avoids a full replay on read. |

## Implemented in #640

1. `hashExternalId` + `truncatePersistedError` helpers in `packages/bot-common/src/masking/`.
2. Hash `chat_quota_events.aggregate_id` at write (3 INSERT sites) + backfill migration.
3. `chat-quota-rebuild.mjs` joins by the learner hash (or anonymous platform hash); days without quota events are skipped, never rebuilt to 0.
4. `truncatePersistedError` applied at all `last_error` / `error_message` write sites listed above (Messenger + Discord report outboxes, shared study-reminder repository incl. the raw-SQL cancel path, dead letters, inbound events, message logs).

Env: `PERSISTED_ERROR_MAX_CHARS` (default 2000) — persisted error text cap; documented in `apps/messenger-bot/.env.example`.

## Follow-ups

- #557 — bound non-terminal `webhook_inbound_events` / dead-letter retention; consider dropping `raw_payload` on terminal state.
- #639 — update the authoritative data catalog to reflect the hashed/truncated fields once it exists.
- #610 — systematic log redaction (separate workstream, already in flight).
