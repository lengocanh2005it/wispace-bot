# Design: Reliability Fixes — #268 + #289

## Scope

| Issue | Title | Status |
|-------|-------|--------|
| #268 | Fix Zalo stale verify reconciliation predicate | **In scope** |
| #274 | Fix PostgreSQL pool timeout configuration | **Skipped** — code and tests already correct |
| #289 | Add lease and compare-and-set for reschedule confirmations | **In scope** |

## #268: Fix Zalo stale verify reconciliation predicate

### Problem

`TypeormZaloLinkVerifyRecordRepository.listStaleRecords()` uses `MoreThan(cutoff)`, which selects records **newer** than the cutoff — the opposite of stale. A crash after WISPACE token verification leaves the local link unrecovered because the reconcile cron never picks up the stale record.

### Fix

1. Change `MoreThan(cutoff)` → `LessThan(cutoff)` in `typeorm-zalo-link-verify-record.repository.ts:37`.
2. Add `ORDER BY verified_at ASC` to process oldest records first.
3. Add `LIMIT 100` to bound the batch (defense-in-depth, consistent with other recovery crons).
4. Import `LessThan` from `typeorm` (replace `MoreThan`).

### Files changed

- `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.ts` — fix query
- `apps/zalo-bot/src/modules/zalo-oauth/infrastructure/typeorm-zalo-link-verify-record.repository.spec.ts` — **new** — unit tests for the repository

### Tests

- `listStaleRecords` returns records older than cutoff (not newer).
- `listStaleRecords` returns empty when all records are fresh.
- `listStaleRecords` respects LIMIT 100.
- `listStaleRecords` returns oldest first.

## #289: Add lease and compare-and-set for reschedule confirmations

### Problem

The reschedule confirmation flow has no processing lease:

1. `takeValid()` sets `status = 'processing'` via CAS (good), but has no owner/timestamp tracking.
2. `revertToPending()` has no lease check — any pod can revert another pod's in-flight row.
3. `cancel()` unconditionally deletes — no ownership check.
4. Crash between `rescheduleSession()` success and `cancel()` leaves a stranding (stuck in `processing`).

### Fix

**Schema change (migration):**

```sql
ALTER TABLE reschedule_confirmations
  ADD COLUMN processing_owner varchar(64),
  ADD COLUMN processing_started_at timestamptz;
```

**Store changes (`TypeormRescheduleStore`):**

1. `takeValid()` — set `processing_owner` (pod identifier) and `processing_started_at = now()` alongside `status = 'processing'`.
2. `revertToPending()` — add `AND processing_owner = $2` guard so only the owning pod can revert.
3. `revertToPending()` — clear `processing_owner` and `processing_started_at` on revert.
4. `cancel()` — add `AND (processing_owner IS NULL OR processing_owner = $2)` guard.
5. New `recoverStaleProcessing(owner, staleAfterMs)` method — resets expired processing rows back to `pending` with extended TTL.

**Recovery cron (new file):**

- `RescheduleRecoveryCronService` — runs every 5 minutes.
- Calls `recoverStaleProcessing()` with `staleAfterMs = 5 * 60_000` (5 minutes).
- Logs recovered count.

**Pod identifier:** Use `process.env.HOSTNAME || os.hostname()` — simple, unique per container, no UUID overhead.

### Files changed

- `packages/database/src/entities/reschedule-confirmation.entity.ts` — add `processingOwner`, `processingStartedAt` columns
- `packages/database/src/services/typeorm-reschedule-store.ts` — lease-aware takeValid/revertToPending/cancel, new recoverStaleProcessing
- `packages/database/src/migrations/YYYYMMDD-HHMMSS-AddRescheduleConfirmProcessingLease.ts` — **new** migration
- `packages/database/src/services/typeorm-reschedule-store.spec.ts` — **new** — unit tests
- `packages/reschedule-confirm/src/reschedule-confirm.service.ts` — no changes (service layer unchanged)
- `packages/reschedule-confirm/src/reschedule-confirm.service.spec.ts` — no changes (existing tests still pass)
- A recovery cron file — **new** — in the appropriate bot module or shared package

### Tests

**Store (`typeorm-reschedule-store.spec.ts`):**

- `takeValid` sets `processing_owner` and `processing_started_at`.
- `revertToPending` only reverts when `processing_owner` matches.
- `revertToPending` does not revert another pod's processing row.
- `cancel` respects ownership guard.
- `recoverStaleProcessing` resets expired processing rows to pending.
- `recoverStaleProcessing` does not touch fresh processing rows.
- `recoverStaleProcessing` does not touch pending/confirmed/cancelled rows.

**Recovery cron:**

- Mock the store, verify `recoverStaleProcessing` is called with correct stale threshold.
- Verify log output on recovery.

### What does NOT change

- `RescheduleConfirmationService` (service layer) — no changes needed. The store handles lease semantics internally.
- `RescheduleConfirmationEntity` status enum — unchanged (`pending | processing | confirmed | cancelled`).
- TTL behavior — 10 minutes, unchanged.
