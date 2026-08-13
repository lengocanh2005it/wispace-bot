# Outbox pattern for study_reminder_jobs and report_send_jobs

Study reminders and report sends use the outbox pattern: write a job row to `study_reminder_jobs` / `report_send_jobs` first, then process asynchronously via a dispatch loop. No message queue (Bull, Redis, SQS) is used for these outbound jobs. Messenger/Zalo webhook ingestion separately persists authenticated events to the PostgreSQL `webhook_inbound_events` durable inbox before acknowledgement; that inbox is inbound recovery, not the outbound job transport.

## Rationale

- **Durability**: Jobs are written to PostgreSQL before processing. If the server crashes mid-way, jobs remain in the DB and are retried when the server restarts.
- **Simple**: PostgreSQL outbox rows and database claims are sufficient for the current multi-pod deployment. No distributed message queue is needed.
- **Natural idempotency**: The `(platform, external_user_id, session_key)` unique constraint on `study_reminder_jobs` ensures syncing multiple times does not create duplicate jobs.
- **Easy debugging**: Query the DB directly to view jobs, states, and history. Debug scripts (`npm run study-reminder:jobs`) read directly from the DB.
- **No additional infrastructure needed**: Redis or a message broker is not required for these job tables. Redis remains optional for selected chat stores, with non-TLS use restricted to private/local networks.

## Alternatives considered

| Alternative | Reason for rejection |
|-------------|---------------------|
| Bull queue (Redis) | Adds Redis infrastructure and queue semantics; the DB outbox meets the current durability and retry needs. |
| SQS (AWS) | Vendor lock-in, additional cost, requires AWS account. |
| In-memory queue | Not durable — server crash loses all jobs. |
| Direct DB polling via cron | No transaction safety — two instances could poll simultaneously. Outbox + claim table solves this. |

## Consequences

- The dispatch loop must poll the DB at a set interval (adaptive poll S2). Not as real-time as push-based queue.
- Requires careful transactions: outbox row and business state must be written in the same transaction.
- Multi-pod dispatch is implemented: report cron uses `scheduled_report_claims` plus an advisory lock, while study-reminder rows are atomically claimed and sync/cleanup crons use advisory locks.
- If throughput is high (>1000 jobs/hour), will need to migrate to a dedicated message queue.
