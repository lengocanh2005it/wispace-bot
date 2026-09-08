# PostgreSQL HA Runbook

This repository assumes one PostgreSQL **writer endpoint** for the shared
`ai_chat_bot_db`. Production must provide a managed multi-AZ primary/standby
or an equivalent provider with automatic unplanned failover and operator-led
planned failover. Keep the writer endpoint stable; do not configure an app
with a list of hosts or a replica endpoint.

## SLO and ownership

- Recovery time objective: 5 minutes or less.
- Recovery point objective: 1 minute or less using provider WAL/PITR.
- No automatic failback after promotion. Validate the new primary first, then
  schedule a separate planned switchover.
- The database owner validates provider failover, backups, and capacity.
  Application owners validate reconnect/readiness and durable workflow checks.

## Connection contract

Set `DB_HOST` to the provider writer endpoint. If PgBouncer is used, set
`PGBOUNCER_DB_HOST` to that same writer endpoint and keep `POOL_MODE=session`;
session-scoped advisory locks require it. `DB_QUERY_TIMEOUT_MS` bounds runtime
queries (the example uses 10 seconds). `DB_MIGRATION_QUERY_TIMEOUT_MS` is
separate because a schema migration may legitimately run longer.

All three bots treat `pg_is_in_recovery() = true` as not ready. During a
promotion, readiness may return 503; traffic can resume when the endpoint is
the writable primary and Redis (when enabled) is reachable. Connection pools
reacquire connections through the stable endpoint; application code does not
blindly retry mutations after an ambiguous network result.

## Migration fencing

Messenger is the only migration owner. The CLI data source verifies the writer
role and acquires `MIGRATION_LOCK_ID` with `pg_try_advisory_lock` on a dedicated
session before invoking TypeORM. The migration executor uses its own session,
so every deploy uses the same fence without a `psql` shell escape. A standby or
busy lock fails closed; retry the deploy after the provider reports the new
primary healthy.

## Failover drill and evidence

The nightly logical backup script uses `DB_HOST`/`DB_PORT` and refuses a
standby. Run it with native `psql`/`pg_dump` on the backup host, or explicitly
set `DB_CONTAINER` to a network-attached client image; it no longer assumes the
database is on `localhost`.

**Backup and restore policy (#865).** The nightly backup is GPG-encrypted at
rest, retained on the VPS, and paired with a globals capture so roles can be
rebuilt (pre-migration dumps are encrypted snapshots; the guarded verifier
covers the nightly artifacts). The only supported restore path is
`deploy/postgres-restore-verify.sh`: it rejects production targets before any
secret use, hands the passphrase over a file descriptor, validates the
archives, restores into a disposable container (default) or an allowlisted
staging target, and records one machine-readable evidence file per run.
Artifacts without a paired `.globals.sql.gz.gpg` fail closed. Promoting a
verified restore into production is a separate database-owner decision; if a
restore must be aborted midway, drop the disposable/staging target and rerun
the verifier with a fresh evidence run — the production database is never
touched by this path.

Run in staging at least quarterly and after provider topology changes:

1. Start a webhook burst, chat quota reservations, a reminder claim, and a
   report claim; record IDs and their committed status.
2. Trigger provider promotion (and separately a planned switchover). Record
   the alert time, promotion time, first successful writer check, readiness
   recovery, and pool reconnect time.
3. Confirm inbound rows are completed or replayable, reserved quota is neither
   double-counted nor lost, and expired leases/claims can be reclaimed.
4. Repeat one ambiguous outbound request and verify it is not blindly replayed;
   inspect dead-letter/attempt metrics for operator action.
5. Restore the latest PITR point and the latest encrypted logical dump into an
   isolated staging database via `deploy/postgres-restore-verify.sh`
   (`--target staging`, allowlisted). The script's JSON evidence retains the
   measured duration and per-check outcomes — attach it with the logs,
   provider failover event, and dashboard screenshots to issue #408 (and
   backup/restore issue #273).

## Monitoring and emergency actions

Alert on provider primary availability, replica/WAL lag (critical above the
1-minute RPO budget), failover/reconnect duration above 5 minutes, PgBouncer
pool wait/exhaustion, and backup/PITR health. During an incident, pause deploys,
verify the writer endpoint and `pg_is_in_recovery()`, then restart only the bot
containers that cannot reacquire connections. Do not promote a second node or
restore over production without database-owner approval and a current backup.

For rollback, keep the promoted primary as the writer, roll back the bot image
only when schema compatibility allows it, and run migrations forward from the
Messenger owner. Never auto-fail back to the former primary.
