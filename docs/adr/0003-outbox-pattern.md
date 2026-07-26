# Outbox pattern for study_reminder_jobs and report_send_jobs

Study reminders and report sends use the outbox pattern: write a job row to `study_reminder_jobs` / `report_send_jobs` first, then process asynchronously via a dispatch loop. No message queue (Bull, Redis, SQS) is used.

## Rationale

- **Durability**: Jobs are written to PostgreSQL before processing. If the server crashes mid-way, jobs remain in the DB and are retried when the server restarts.
- **Simple for POC**: Single-instance, no distributed queue needed. Outbox in the DB is sufficient.
- **Natural idempotency**: `sessionKey` unique constraint on `study_reminder_jobs` ensures syncing multiple times does not create duplicate jobs.
- **Easy debugging**: Query the DB directly to view jobs, states, and history. Debug scripts (`npm run study-reminder:jobs`) read directly from the DB.
- **No additional infrastructure needed**: No Redis or message broker required for the POC stage.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Bull queue (Redis) | Requires Redis infrastructure. More complex than the POC needs. Can reconsider when scaling. |
| SQS (AWS) | Vendor lock-in, additional cost, requires AWS account. |
| In-memory queue | Not durable — server crash loses all jobs. |
| Direct DB polling via cron | No transaction safety — two instances could poll simultaneously. Outbox + claim table solves this. |

## Consequences

- The dispatch loop must poll the DB at a set interval (adaptive poll S2). Not as real-time as push-based queue.
- Requires careful transactions: outbox row and business state must be written in the same transaction.
- When scaling to multi-pod, leader election is needed (`scheduled_report_claims` + advisory lock) so only one pod dispatches. This is already implemented.
- If throughput is high (>1000 jobs/hour), will need to migrate to a dedicated message queue.
