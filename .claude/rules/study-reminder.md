---
alwaysApply: false
paths: apps/messenger-bot/src/modules/study-reminder/**
---

# Study reminder module

## Flow

```
POST /messenger/study-calendar/sync { userId }
  → StudyReminderSyncService (GET UserCalendar, x-psid)
  → study_reminder_jobs (pending)
  → StudyReminderDispatchService (1-minute cron)
  → StudyReminderService (LLM) + MESSAGE_SENDER (MessengerOutbound)
```

Wispace **must** call sync after POST/DELETE `UserCalendar`. The 30-minute cron is only a fallback.

## Cross-platform learner consistency (#637)

WISPACE numeric `userId` is the canonical owner. Sync resolves one preferred
platform (`preferred_platform`, then `zalo > discord > messenger`) and keeps one
active reminder job for that learner; a platform switch cancels the old pending
owner and converges on the new one. An active mapping without `userId` is not an
anonymous reminder recipient and is skipped fail-closed. Unlinking a channel
does not erase learner-level state; explicit privacy deletion by `userId` does.

## Canonical platform gate (#718)

Every Messenger, Discord, and Zalo full-sync provider must inject the shared
`CanonicalPlatformService` into `StudyReminderSyncService`. The resolver keeps
an active mapping preferred, then falls back to `zalo > discord > messenger`.
Noncanonical mappings skip upsert and cancel only `pending` / `failed` jobs on
that platform; `processing` jobs are not force-cancelled. An undefined result
may cancel actionable jobs without upserting, while resolver errors leave jobs
untouched and surface a sync failure. A later full sync reconciles jobs when
the canonical platform changes.

Reminder delivery uses the shared outbound learner-message backstop (#622).
Treat `rate_limited` as terminal (`outbound_rate_limited`), do not retry it,
and use `docs/outbound-rate-limit.md` for first triage. A normal reminder must
not trip the default cap.

## Chat reschedule scope (#627)

- Treat every model- or learner-supplied `calendarId` as untrusted; list
  upcoming entries first and use only an ID from the caller-scoped list.
- Calendar reads and the shared confirmation/write stages validate the linked
  WISPACE `userId`. Never expose the internal ownership proof to the model.
- Scope mismatch or an unverified owner fails closed before any WISPACE write;
  do not retry. Return the generic scope error and meter
  `scope_mismatch`/`scope_unverified` with masked IDs in logs.
- Before release, record WISPACE's per-endpoint confirmation that resource IDs
  are authorized against the identity header in the issue conversation.

## Required config

`STUDY_REMINDER_*` variables in `.env` — use `readRequiredPositiveNumber`, **no** hardcoded fallback values in code.

## Main files (Clean Architecture)

| File                                                          | Layer          | Role                                                                                                                                          |
| ------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `application/services/study-reminder-sync.service.ts`         | application    | Sync calendar → jobs                                                                                                                          |
| `application/services/study-reminder-dispatch.service.ts`     | application    | Claim + send (via `MESSAGE_SENDER`)                                                                                                           |
| `application/services/study-reminder-schedule.service.ts`     | application    | Read `STUDY_REMINDER_*` from `.env`, delegate pure computation (`remind_at`, session-started, time label) to `@wispace/study-reminder-shared` |
| `application/services/study-reminder-worker.service.ts`       | application    | Cron sync/dispatch/rollover                                                                                                                   |
| `infrastructure/wispace/user-calendar-api.service.ts`         | infrastructure | GET UserCalendar (x-psid)                                                                                                                     |
| `infrastructure/persistence/study-reminder-job.repository.ts` | infrastructure | CRUD jobs                                                                                                                                     |
| `application/ports/messenger-mapping.port.ts`                 | application    | Read mapping — do not import `MessengerModule`                                                                                                |

## Tests

Modify `remind_at` logic → `application/services/study-reminder-schedule.service.spec.ts`.

## Debug

```bash
npm run study-reminder:jobs
npm run study-reminder:sync-only
```

## Upsert job on schedule change

`StudyReminderJobRepository.upsertPendingJob`:

- `sent` + **same** time → keep `sent` (no duplicate reminder)
- `sent` + **changed** time/topic → reopen as `pending`
- `cancelled` (session returns to sync) → reopen as `pending`
- `processing` + time changed → reopen as `pending`

Spec: `infrastructure/persistence/study-reminder-job.repository.spec.ts`
