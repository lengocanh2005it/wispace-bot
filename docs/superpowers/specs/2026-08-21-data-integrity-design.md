# Design: Data Integrity — #295 + #293

## Scope

| Issue | Title | Status |
|-------|-------|--------|
| #295 | Add CHECK constraints for state-machine enums | In scope |
| #293 | Chat quota recovery consistent with outbound delivery | Partial fix — document + metric |

## #295: CHECK constraints for enum columns

### Problem

All enum-like columns (`status`, `platform`, `direction`) are bare `varchar` — no DB-level validation. Invalid values can be inserted via raw SQL.

### Fix

Add CHECK constraints via migration. Validate existing rows first (fail-closed).

**Tables and constraints:**
- `webhook_inbound_events`: `status IN ('pending','processing','completed','failed','abandoned')`, `platform IN ('messenger','discord','zalo')`
- `study_reminder_jobs`: `status IN ('pending','processing','sent','failed','cancelled')`, `platform IN ('messenger','discord','zalo')`
- `report_send_jobs`: `status IN ('pending','processing','sent','failed')`, `platform IN ('messenger','discord','zalo')`
- `webhook_dead_letters`: `status IN ('pending','replayed','abandoned')`, `direction IN ('inbound','outbound')`, `platform IN ('messenger','discord','zalo')`
- `chat_idempotency`: `status IN ('reserved','delivered','completed','refunded')`, `platform IN ('messenger','discord','zalo')`

### Files changed

- `packages/database/src/migrations/20260821000003-AddEnumCheckConstraints.ts` — **new** migration

## #293: Document ambiguous recovery + add metric

### Problem

Recovery cron refunds `reserved` rows even when the provider actually delivered the message. Crash window is narrow but real.

### Fix

Add a metric counter for ambiguous recoveries. Document the known limitation. Full fix (intermediate `sending` state) deferred to follow-up.

### Files changed

- `packages/chat-metering/src/chat-rate-limit/chat-rate-limit.repository.ts` — add metric emission on ambiguous recovery
- `docs/edge-cases-roadmap.md` — document the known limitation
