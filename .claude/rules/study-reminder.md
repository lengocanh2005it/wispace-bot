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

## Required config

`STUDY_REMINDER_*` variables in `.env` — use `readRequiredPositiveNumber`, **no** hardcoded fallback values in code.

## Main files (Clean Architecture)

| File | Layer | Role |
|------|-------|------|
| `application/services/study-reminder-sync.service.ts` | application | Sync calendar → jobs |
| `application/services/study-reminder-dispatch.service.ts` | application | Claim + send (via `MESSAGE_SENDER`) |
| `application/services/study-reminder-schedule.service.ts` | application | Read `STUDY_REMINDER_*` from `.env`, delegate pure computation (`remind_at`, session-started, time label) to `@wispace/study-reminder-core` |
| `application/services/study-reminder-worker.service.ts` | application | Cron sync/dispatch/rollover |
| `infrastructure/wispace/user-calendar-api.service.ts` | infrastructure | GET UserCalendar (x-psid) |
| `infrastructure/persistence/study-reminder-job.repository.ts` | infrastructure | CRUD jobs |
| `application/ports/messenger-mapping.port.ts` | application | Read mapping — do not import `MessengerModule` |

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
