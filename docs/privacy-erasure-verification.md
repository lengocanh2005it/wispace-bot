# Privacy erasure verification

This note is the verification record for #995 and tickets #1128–#1131. The
completion rule and ownership decision are recorded in
[ADR-0014](adr/0014-privacy-erasure-completion.md); the terms are in the
`Privacy & Erasure` section of `CONTEXT.md`.

## Automated evidence

The shared seams cover durable job idempotency, bounded request retries,
generation fencing, worker recovery, HTTP status mapping, metrics, and Ops
Health alerts:

```text
npm run test --workspace=@wispace/database -- privacy-data.service.spec.ts
npm run test --workspace=@wispace/database -- privacy-cleanup-job.service.spec.ts
npm run test --workspace=@wispace/database -- privacy-cleanup-reconciler.service.spec.ts
npm run test --workspace=@wispace/database -- migration-naming.spec.ts
npm run test --workspace=@wispace/bot-common -- platform-ops.controller.spec.ts
npm run test --workspace=@wispace/bot-metrics -- bot-metrics.service.spec.ts
npm run test --workspace=@wispace/ops-health -- ops-health.service.spec.ts
npm run test --workspace=@wispace/ops-health -- typeorm-ops-health.repository.spec.ts
npx turbo run typecheck --concurrency=1 --filter=@wispace/messenger-bot... --filter=@wispace/discord-bot... --filter=@wispace/zalo-bot...
```

The migration is additive, has no backfill, and is registered in every bot's
shared TypeORM entity list. The existing immutable-image migration barrier
therefore runs it before an application cutover.

## PostgreSQL/Redis recovery drill

Run this against an isolated loopback PostgreSQL and Redis pair with the
normal test environment loaded (`NODE_ENV=test`, `DB_HOST=127.0.0.1`,
`REDIS_HOST=127.0.0.1`):

1. Apply migrations and start all three bots at the same release SHA.
2. Seed one linked identity and the four applicable state stores for Messenger
   (three for Discord/Zalo), then call each bot's own internal
   `privacy/unlink` and `privacy/delete` endpoint while Redis is stopped.
3. Confirm HTTP `202`, `status: "incomplete"`, an opaque `cleanupId`, and only
   the failed canonical stores in `outstandingStores`; the PostgreSQL
   mutation and durable jobs must already be committed.
4. Stop the request process, restart the same bot, restore Redis, and run its
   five-minute reconciler once. Confirm the fresh process claims the jobs and
   reaches `completed` without rerunning stores already marked complete.
5. Relink the external identity at a newer ownership generation before a
   retry. Confirm the old job becomes `stale` and the new owner's Redis state
   remains intact.
6. Repeat the delete path for Discord and Zalo. Verify fan-out calls each
   platform endpoint with that platform's identity; no adapter receives an
   identity owned by another bot.

The existing `npm run database:privacy-smoke` remains the PostgreSQL
transaction/registry smoke. It intentionally exercises the legacy no-adapter
path; the recovery drill above is the durable Redis check.

## Observability and retention checks

- Prometheus labels are limited to `platform`, `operation`, `store`, and
  bounded outcome values; raw external identities are never labels or log
  fields.
- `*_privacy_cleanup_pending_jobs` and
  `*_privacy_cleanup_pending_job_age_seconds` expose backlog and age.
- Ops Health emits `PRIVACY_CLEANUP_INCOMPLETE` for actionable work and
  `PRIVACY_CLEANUP_RECOVERY_STUCK` when the oldest work is over 15 minutes or
  retry pressure is present.
- A retention query deletes only `completed`/`stale` rows older than seven
  days. `pending`/`processing` rows remain actionable.
