---
name: study-reminder-debug
description: Debug study reminder jobs — sync, dispatch, remind_at, job status. Use when user asks about study reminders, study_reminder_jobs, sync not running, job pending/sent/failed, or Wispace calendar sync.
---

# Debug study reminder

## 1. Read context

- `apps/messenger-bot/docs/study-session-reminder.md` (sync/dispatch/rollover flow)
- `.claude/rules/study-reminder.md`

## 2. Check jobs in DB

```bash
npm run study-reminder:jobs
npm run study-reminder:jobs -- --failed
npm run study-reminder:jobs -- --stuck
npm run study-reminder:jobs -- --summary
npm run ops:health
```

Check: `status`, `remind_at`, `scheduled_at`, `session_key`, `retry_count`.

## 3. Manual sync

```bash
npm run study-reminder:sync-only
```

Or ops API (requires `X-Internal-Api-Key`):

```http
POST /messenger/study-calendar/sync
{ "userId": 123 }

POST /messenger/sync-study-reminders
POST /messenger/send-study-reminders
```

## 4. Common issues checklist

- [ ] User has `external_user_id` in `user_platform_mappings` (status ACTIVE)?
- [ ] `STUDY_REMINDER_*` set in `.env`?
- [ ] `remind_at` has passed but `scheduled_at` is still in the future?
- [ ] Wispace called sync after changing schedule? (common integration gap)
- [ ] UserCalendar API returns correct schedule for `x-psid`?
- [ ] Chat reschedule used `list_study_calendar_entries` first and a caller-scoped entry?
- [ ] Check `RESCHEDULE_SCOPE_BLOCKED` and `*_llm_tool_policy_denied_total` for
      `scope_mismatch`/`scope_unverified`; these denials are deterministic and
      must not be retried.
- [ ] WISPACE per-endpoint resource authorization against the identity header
      is confirmed in the issue conversation (external integration evidence).

## 5. Code changes

- Schedule logic → `study-reminder-schedule.service.ts` + spec
- Sync → `study-reminder-sync.service.ts`
- Dispatch → `study-reminder-dispatch.service.ts`

After changes: `npm run build && npm run test`
