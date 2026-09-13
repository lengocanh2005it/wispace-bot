# Data catalog — persisted fields, retention, and erasure

Read 2026-09-13. Closes gap 2 of
[`docs/research/security-coverage-audit-2026-09-11.md`](./research/security-coverage-audit-2026-09-11.md)
("no authoritative, repository-wide data catalog that maps every persisted
field to source, owner, retention, and erasure behavior"), indexed by #693.

## Method and confidence

Derived by reading source, not by inspecting a live database:

- **Tables and columns** — every `@Entity('…')` in `packages/` and `apps/`
  (30 tables, `dist/` and specs excluded), with column names taken from the
  decorator `name:` option or the camelCase property name. `?` marks
  `nullable: true`.
- **Retention** — the cleanup crons in `packages/cleanup-cron/`,
  `packages/webhook-inbound/`, `packages/chat-metering/`, and the
  Messenger-local cleanup services, with the default each reads when its env
  var is unset.
- **Erasure** — `PrivacyDataService` in
  `packages/database/src/services/privacy-data.service.ts`: `MAPPING_TABLES`,
  `VERIFY_INTENT_TABLES`, and `SCOPED_ENTITY_NAMES`.

What this catalog does **not** establish: actual row counts, whether a
retention cron is enabled in production, and whether any table holds data the
column names do not reveal. Every "no" below means "no code path found", which
is a claim about this repository, not about the database.

`message_logs` is declared by three entity files (one per bot) against one
shared table; the column union is listed once.

## Summary

Learner data = the row can be attributed to an identified learner, through
`user_id`, a platform user id, or a payload containing either.

| Table | Learner data | Retention | Erased by `PrivacyDataService` |
| --- | --- | --- | --- |
| `user_platform_mappings` | yes | none | **yes** (mapping) |
| `discord_account_links` | yes | none | **yes** (mapping) |
| `zalo_account_links` | yes | none | **yes** (mapping) |
| `messenger_link_verify_records` | yes | reconcile cron past `MESSENGER_LINK_RECONCILE_MAX_AGE_MS` | **yes** (verify intent) |
| `discord_link_verify_records` | yes | reconcile cron past `DISCORD_LINK_RECONCILE_MAX_AGE_MS` | **yes** (verify intent) |
| `zalo_link_verify_records` | yes | reconcile cron past `ZALO_LINK_RECONCILE_MAX_AGE_MS` | **yes** (verify intent) |
| `learner_profiles` | yes | none | **yes** (scoped) |
| `study_reminder_jobs` | yes | `STUDY_REMINDER_JOB_RETENTION_DAYS`, default 7 | **yes** (scoped) |
| `scheduled_report_claims` | yes | `REPORT_CLAIMS_RETENTION_DAYS`, default 90 | **yes** (scoped) |
| `learner_scheduled_report_claims` | yes | `REPORT_CLAIMS_RETENTION_DAYS`, default 90 | **yes** (scoped) |
| `report_send_jobs` | yes | none | **yes** (scoped) |
| `chat_daily_usage` | yes | none | **yes** (scoped) |
| `chat_idempotency` | yes | `CHAT_IDEMPOTENCY_RETENTION_DAYS`, default 90 | **yes** (scoped) |
| `llm_usage_events` | yes | `LLM_USAGE_RETENTION_DAYS`, default 90 | **yes** (scoped) |
| `web_activity` | yes | none | **yes** (scoped, `user_id` only) |
| `user_notification_preferences` | yes | none | **yes** (scoped, `user_id` only) |
| `message_logs` | yes | `<PREFIX>MESSAGE_LOG_RETENTION_DAYS`, default 90 | **no** |
| `webhook_inbound_events` | yes, raw payload | `WEBHOOK_INBOUND_RETENTION_DAYS`, default 30 | **no** |
| `webhook_dead_letters` | yes, raw payload | `<PREFIX>DEAD_LETTER_RETENTION_DAYS`, default 30 | **no** |
| `llm_safety_events` | yes | `LLM_SAFETY_EVENT_RETENTION_DAYS`, default 30 | **no** |
| `chat_tool_daily_usage` | yes | `CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS`, default 7 | **no** |
| `chat_quota_events` | pseudonymised | `CHAT_QUOTA_EVENTS_RETENTION_DAYS`, default 90 | **no** |
| `reschedule_confirmations` | yes | row TTL via `expires_at` | **no** |
| `discord_welcome_records` | yes, platform id | none | **no** |
| `zalo_welcome_records` | yes, platform id | none | **no** |
| `platform_link_audit_events` | hashed id | `PLATFORM_LINK_AUDIT_RETENTION_DAYS`, default 90 | **no** (by design) |
| `discord_oauth_states` | transient | 10 minutes | **no** (expires first) |
| `zalo_oauth_states` | transient | 10 minutes | **no** (expires first) |
| `zalo_oa_tokens` | no, OA credentials | none | n/a |
| `cron_leader_leases` | no, infrastructure | lease expiry | n/a |

## Findings

### 1. Erasure misses seven tables that carry learner identifiers

`PrivacyDataService` covers 16 of the 30 tables. Outside that set, and holding
data attributable to a learner:

`message_logs`, `webhook_inbound_events`, `webhook_dead_letters`,
`llm_safety_events`, `chat_tool_daily_usage`, `reschedule_confirmations`, and
the two `*_welcome_records` tables.

Every one of them is bounded by *time*, not by the erasure request. A learner
who asks for deletion today still has rows in `message_logs` for up to 90 more
days and in `webhook_inbound_events` for up to 30, and welcome records for
ever. Whether that is acceptable is a policy question this catalog does not
answer — but it should be answered deliberately rather than by omission,
because the retention windows were chosen for operational reasons and not as
a privacy commitment.

**Most of this shortfall already has an owner**, found by searching the open
backlog after this table was built: #908 for the raw payloads, #540 for
`reschedule_confirmations`, #556 for `llm_safety_events` plus the unbounded
per-user tables, #541 for `chat_quota_events`, #522 for NULL-`user_id` rows,
and #448 for pre-link usage rows. Only `message_logs` and
`chat_tool_daily_usage` were named by none of them; #1125 covers those two.
The value of this catalog is therefore the consolidated map rather than the
individual gaps — several of which were already known.

### 2. Two of those tables hold the learner's own message text

`webhook_inbound_events.raw_payload` and `webhook_dead_letters.raw_payload`
store the platform webhook body verbatim, which for a chat event includes what
the learner typed. These are the highest-sensitivity rows in the schema and
they are in the not-erased group.

### 3. Five tables holding learner data have no retention bound at all

`learner_profiles`, `report_send_jobs`, `chat_daily_usage`, `web_activity`,
`user_notification_preferences` — plus the mapping tables, which are meant to
be durable. These grow with the learner base and shrink only on erasure. For
the mapping and preference tables that is intended; for `report_send_jobs` and
`chat_daily_usage`, which are operational records rather than state, it may
not be.

### 4. `*_welcome_records` are permanent and invisible

Keyed by platform user id, with no cleanup cron and no erasure path. They are
a permanent record that a given Discord or Zalo account interacted with the
bot, surviving both unlinking and a deletion request. The rows are small and
the intent (dedupe the welcome DM) is sound; the lifetime is the problem.

### 5. Pseudonymisation is applied unevenly

`platform_link_audit_events.external_user_hash` and
`chat_quota_events.aggregate_id` (hashed by migration
`1786937000000-HashChatQuotaAggregateId`) store hashed identifiers, and
`chat_quota_events` additionally keeps a raw `user_id` — which is what #541
tracks. Everywhere else the platform id is stored in the clear. The rule
deciding which identifiers get hashed is not written down anywhere.

## Field detail

Columns as declared. `?` = nullable.

### Identity and linking

**`user_platform_mappings`** — Messenger mapping, and the canonical
cross-platform identity row.
`id, user_id?, platform, external_user_id?, notification_messages_token, cadence?, topic?, status, link_state, mapping_generation, last_verified_at?, last_unknown_at?, revoked_at?, revocation_reason?, upstream_ownership_version?, created_at, updated_at`
Source: OAuth callback and webhook opt-in. Owner: account-link context.

**`discord_account_links`**, **`zalo_account_links`** — same shape per platform.
`id, platform, external_user_id, user_id, linked_at, updated_at, link_state, mapping_generation, last_verified_at?, last_unknown_at?, revoked_at?, revocation_reason?, upstream_ownership_version?, optin_prompt_sent_at?, optout_notice_sent_at?`

**`messenger_link_verify_records`**
`psid, user_id, intent_generation, ref_fingerprint?, topic, cadence, status, verified_at, lease_token?, lease_expires_at?`

**`discord_link_verify_records`** / **`zalo_link_verify_records`**
`<platform>_user_id, user_id, verified_at, intent_generation, observed_mapping_kind, observed_mapping_generation?`

**`platform_link_audit_events`** — hashed-id audit trail; deliberately outside
erasure so the audit survives the deletion it records.
`id, platform, external_user_hash, mapping_generation?, event_type, reason?, ownership_version?, created_at`

**`discord_oauth_states`** `state, link_token, created_at` — `link_token` is
AES-256-GCM ciphertext.
**`zalo_oauth_states`** `state, code_verifier, link_token, created_at` — adds
the PKCE verifier.

**`discord_welcome_records`** / **`zalo_welcome_records`**
`<platform>_user_id, last_welcomed_at?, source?, claim_expires_at?, updated_at`

### Learning data

**`learner_profiles`** — cached WISPACE goals. Source: WISPACE API, not learner input.
`platform, external_user_id, user_id?, target_score?, target_score_fetched_at?, exam_date?, exam_date_fetched_at?, updated_at`

**`web_activity`** `user_id, last_active_at, updated_at`

**`user_notification_preferences`** — consent state (#596).
`user_id, preferred_platform?, report_enabled?, reminder_enabled?, created_at, updated_at`

### Delivery and scheduling

**`study_reminder_jobs`** — the reminder outbox.
`id, platform, external_user_id, user_id?, mapping_generation?, session_key, scheduled_at, remind_at, topic?, status, retry_count, max_retries, next_retry_at?, last_error?, sent_at?, lease_token?, lease_expires_at?, delivery_record?, delivery_key?, delivery_status?, processing_started_at?, created_at, updated_at`

**`report_send_jobs`**
`id, platform, external_user_id, user_id?, exam_date, first_attempt_date, status, retry_count, max_retries, next_retry_at?, last_error?, sent_at?, lease_token?, lease_expires_at?, created_at, updated_at`

**`scheduled_report_claims`** (legacy, platform-keyed) and
**`learner_scheduled_report_claims`** (learner-keyed) — both live; the
per-learner table is the newer one.
`id, [user_id,] platform, external_user_id, report_date, [report_type,] status, lease_token?, lease_expires_at?, delivery_record?, delivery_key?, delivery_status?, processing_started_at?, created_at, updated_at`

**`reschedule_confirmations`** — pending confirm-before-write state, TTL'd.
`id, external_id, tool_name, platform, user_id, mapping_version, intent_hash, args_hash, nonce, calendar_id, scheduling_mode, new_local_date?, new_time?, session_label, status, lease_token?, processing_started_at?, expires_at, created_at, updated_at`

### Messaging and webhooks

**`message_logs`** — one shared table, three entity declarations.
`id, platform, external_user_id, user_id?, status, error_message?, message_type, created_at`

**`webhook_inbound_events`** — durable inbox; `raw_payload` is the verbatim
webhook body.
`id, platform, event_id, external_user_id?, event_type?, raw_payload, status, retry_count, last_error?, next_retry_at?, lease_token?, processed_at?, created_at, updated_at`

**`webhook_dead_letters`** — same payload sensitivity, both directions.
`id, platform, external_user_id?, message_mid?, direction, raw_payload, error_message, retry_count, status, replayed_at?, delivery_key?, delivery_status?, processing_started_at?, lease_token?, lease_expires_at?, created_at, updated_at`

### Metering and LLM

**`chat_daily_usage`** `id, platform, external_user_id, user_id?, usage_date, free_form_count, created_at, updated_at`

**`chat_idempotency`** `idempotency_key, platform, external_user_id, user_id?, usage_date, reserved_at, status, updated_at`

**`chat_tool_daily_usage`** `id, platform, external_user_id, user_id, usage_date, tool_name, count, created_at, updated_at`

**`chat_quota_events`** — `aggregate_id` hashed, `user_id` still raw (#541).
`id, platform, aggregate_id, aggregate_type, event_type, payload, occurred_at, usage_date, user_id?, idempotency_key?`

**`llm_usage_events`** — cost and token accounting; no message content.
`id, occurred_at, usage_date, feature, platform, provider, external_user_id?, user_id?, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, openai_response_id?, correlation_id?, tool_round?, status, error_message?, estimated_cost_usd?`

**`llm_safety_events`** — `payload` holds redacted excerpts of flagged input
(`redact-safety-text.ts`).
`id, feature, event_type, reason?, platform, external_user_id?, user_id?, correlation_id?, payload?, created_at`

### Infrastructure

**`zalo_oa_tokens`** — OA credentials, encrypted at rest, not learner data.
`id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at, version`

**`cron_leader_leases`** `name, instance_id, expires_at, created_at, updated_at`

## Open questions

These need a decision, not more reading:

1. Is time-bounded retention an acceptable substitute for erasure on the seven
   tables in finding 1 — and if so, is that written down anywhere a learner
   request can be answered from?
2. Should `raw_payload` be erased or truncated on a deletion request, given it
   contains the learner's own words?
3. Do `*_welcome_records` need a lifetime, or a hashed key like
   `platform_link_audit_events` uses?
4. What is the rule for which identifiers get hashed? Applying
   `platform_link_audit_events`' approach more widely would shrink the erasure
   surface rather than expand the erasure code.
5. Should `report_send_jobs` and `chat_daily_usage` have a retention bound?
   (#556 covers this one.)

Questions 1–4 have partial owners listed under finding 1; none of them owns
the *policy* answer, which is what these questions ask for.

## Related

- #693 — audit coverage map
- #915 and [`threat-model-wispace-data-and-outbound.md`](./threat-model-wispace-data-and-outbound.md) — the flows this data moves along
- #1125 — `message_logs` and `chat_tool_daily_usage`, the two tables no other erasure issue names
- #908, #540, #556, #541, #522, #448 — the erasure and retention gaps that already had owners
- #596 — notification consent state
- `docs/research/security-coverage-audit-2026-09-11.md` — the report that named this gap
