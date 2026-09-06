import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Real-Postgres/Redis persistence-semantics pinning for #538: the services
 * whose correctness lives in composed SQL (or Lua) cannot be proven by the
 * mocked Jest specs, which assert call shapes instead of executing the
 * predicate. Every case below runs against real Postgres 16 (+ real Redis
 * for the Lua section) and would fail if the SQL regressed.
 *
 * - cron-leader-lease: first-wins, rival-loses-while-unexpired, takeover
 *   after expiry, owner/non-owner heartbeat, fail-open on DB outage, and a
 *   two-worker claim race (exactly one winner).
 * - webhook inbox listDue/countDue: platform isolation (#445 shape — an
 *   unparenthesized OR would leak cross-platform rows), due-state matrix
 *   (pending / failed-due / failed-future / failed-null-backoff / stale vs
 *   fresh processing / completed), and countDue == listDue length.
 * - quota idempotency: double reserve of one key returns null (ON
 *   CONFLICT DO NOTHING yields zero rows), a distinct key still inserts.
 * - Lua: burst over-limit + concurrent exact-limit-wins + key-reset, slot
 *   over-limit + stale-release no-op + lease expiry.
 * - privacy delete: a mid-transaction failure (fault trigger) rolls back
 *   every earlier write — zero partial effects.
 *
 * Usage: node scripts/database-persistence-semantics-smoke.mjs
 * Requires NODE_ENV=test + loopback DB_HOST (+ loopback REDIS_HOST) and the
 * built dists (CI builds all bots first). Creates only `smoke-*` rows plus
 * a temporary trigger, all removed in `finally`.
 */

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DataSource } = require('typeorm');
const {
  CronLeaderLeaseEntity,
  CronLeaderLeaseService,
  WebhookInboundEventEntity,
  PlatformLinkAuditEventEntity,
  PrivacyDataService,
} = require('@wispace/database');
const { PlatformWebhookInboundEventService } = require('@wispace/webhook-inbound');
const { RedisBurstCounter } = require('@wispace/chat-metering');
const { ChatRateLimitRepository } = require('@wispace/chat-metering');
const {
  ChatDailyUsageEntity: QuotaDailyUsageEntity,
  ChatIdempotencyEntity: QuotaIdempotencyEntity,
} = require('@wispace/chat-metering');
const { acquireRedisSlot, LlmOverloadError } = require('@wispace/llm-agent');
const messengerDatabase = require(
  resolve(
    rootDir,
    'apps/messenger-bot/dist/infrastructure/database/database.module.js',
  ),
);
const discordDatabase = require(
  resolve(
    rootDir,
    'apps/discord-bot/dist/infrastructure/database/database.module.js',
  ),
);
const zaloDatabase = require(
  resolve(
    rootDir,
    'apps/zalo-bot/dist/infrastructure/database/database.module.js',
  ),
);

for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
  if (!process.env[key]?.trim()) {
    throw new Error(`persistence semantics smoke requires ${key}`);
  }
}
if (
  process.env.NODE_ENV !== 'test' ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.DB_HOST.trim().toLowerCase(),
  )
) {
  throw new Error(
    'persistence semantics smoke requires NODE_ENV=test and a loopback DB_HOST',
  );
}
if (
  !process.env.REDIS_HOST?.trim() ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.REDIS_HOST.trim().toLowerCase(),
  )
) {
  throw new Error('persistence semantics smoke requires a loopback REDIS_HOST');
}

// Registries the apps actually wire (same #461 rationale as the privacy
// smoke: a local copy would pass while an app's real registration was wrong).
// The cross-app agreement itself is pinned by database-privacy-smoke; here we
// additionally assert the targets THIS script touches resolve identically in
// all three apps, so a divergent registration cannot silently change what
// the rollback section below deletes.
const registry = messengerDatabase.buildPrivacyEntityRegistry();
for (const [platform, builder] of [
  ['discord', discordDatabase.buildPrivacyEntityRegistry],
  ['zalo', zaloDatabase.buildPrivacyEntityRegistry],
]) {
  const other = builder();
  for (const key of Object.keys(registry.mappings)) {
    assert.equal(
      other.mappings[key],
      registry.mappings[key],
      `${platform} registry disagrees on mappings.${key}`,
    );
  }
  for (const key of [
    'learnerProfile',
    'studyReminderJob',
    'chatDailyUsage',
    'chatIdempotency',
  ]) {
    assert.equal(
      other.scoped[key],
      registry.scoped[key],
      `${platform} registry disagrees on scoped.${key}`,
    );
  }
}
console.log('  ok: touched registry targets agree across apps');
const ENTITIES = [
  CronLeaderLeaseEntity,
  WebhookInboundEventEntity,
  PlatformLinkAuditEventEntity,
  ...Object.values(registry.mappings),
  ...Object.values(registry.scoped),
  registry.messageLog,
];

function dataSourceOptions() {
  return {
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
    logging: false,
    entities: ENTITIES,
    synchronize: true,
    migrations: [],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noopLogger = { warn: () => {} };

/** Minimal RedisClientPort — same 4-method surface the apps depend on. */
function redisClientPort(redis) {
  return {
    isEnabled: () => true,
    isConfiguredEnabled: () => true,
    ping: () => redis.ping(),
    getNativeClient: () => redis,
  };
}

async function delKeys(redis, pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

let dataSource;
let redis;

async function leaseSuite() {
  console.log('lease: cron-leader-lease acquire/expiry/takeover/fail-open');
  const repo = dataSource.getRepository(CronLeaderLeaseEntity);
  const svc = new CronLeaderLeaseService(repo);
  const read = (name) =>
    repo.findOne({ where: { name } }).then((row) => row ?? null);

  // 1. First claim wins.
  assert.equal(await svc.claim('smoke-lease-1', 'pod-a'), true);
  assert.equal((await read('smoke-lease-1')).instanceId, 'pod-a');
  console.log('  ok: first claim wins');

  // 2. Rival loses while unexpired; row untouched (pins the WHERE-gated
  // no-row path → [] → false).
  assert.equal(await svc.claim('smoke-lease-1', 'pod-b'), false);
  assert.equal((await read('smoke-lease-1')).instanceId, 'pod-a');
  console.log('  ok: rival loses while unexpired, row unchanged');

  // 3. Takeover after expiry (backdated — the 3-minute TTL is not waited out).
  await dataSource.query(
    `UPDATE cron_leader_leases SET expires_at = now() - interval '1 hour' WHERE name = $1`,
    ['smoke-lease-1'],
  );
  assert.equal(await svc.claim('smoke-lease-1', 'pod-b'), true);
  assert.equal((await read('smoke-lease-1')).instanceId, 'pod-b');
  console.log('  ok: takeover after expiry');

  // 4. Owner heartbeat extends the lease.
  const before = (await read('smoke-lease-1')).expiresAt.getTime();
  await sleep(10);
  await svc.heartbeat('smoke-lease-1', 'pod-b');
  const after = (await read('smoke-lease-1')).expiresAt.getTime();
  assert.ok(after > before, 'heartbeat did not extend expires_at');
  console.log('  ok: owner heartbeat extends');

  // 5. Non-owner heartbeat is a no-op.
  await svc.heartbeat('smoke-lease-1', 'pod-c');
  const row = await read('smoke-lease-1');
  assert.equal(row.instanceId, 'pod-b');
  assert.equal(row.expiresAt.getTime(), after);
  console.log('  ok: non-owner heartbeat no-op');

  // 6. Fail-open: a dead database still returns true (#269 — a DB blip must
  // not block the cron; the advisory lock still serializes between pods).
  const dead = new DataSource(dataSourceOptions());
  await dead.initialize();
  await dead.destroy();
  const deadSvc = new CronLeaderLeaseService(
    dead.getRepository(CronLeaderLeaseEntity),
  );
  assert.equal(await deadSvc.claim('smoke-lease-dead', 'pod-a'), true);
  console.log('  ok: fail-open on DB outage');

  // 7. Two-worker race: exactly one winner, row owned by the winner.
  const [w1, w2] = await Promise.all([
    svc.claim('smoke-lease-race', 'worker-1'),
    svc.claim('smoke-lease-race', 'worker-2'),
  ]);
  assert.equal(
    [w1, w2].filter(Boolean).length,
    1,
    `expected exactly one winner, got ${w1}/${w2}`,
  );
  const winner = w1 ? 'worker-1' : 'worker-2';
  assert.equal((await read('smoke-lease-race')).instanceId, winner);
  console.log('  ok: duplicate claim race has exactly one winner');
}

async function inboxSuite() {
  console.log('inbox: listDue/countDue platform isolation + due-state matrix');
  const repo = dataSource.getRepository(WebhookInboundEventEntity);
  const messenger = new PlatformWebhookInboundEventService('messenger', repo);
  const zalo = new PlatformWebhookInboundEventService('zalo', repo);

  const seed = async (eventId, platform, mutate) => {
    const res = await messenger.ingest({
      eventId,
      externalUserId: 'smoke-user',
      eventType: 'message',
      rawPayload: { smoke: true },
    });
    assert.equal(res.inserted, true, `${eventId} should insert`);
    // ingest() always stores platform from its own service instance, so
    // cross-platform seeds go through raw SQL below via mutate().
    if (mutate) await mutate(res.id);
    return res.id;
  };
  // ingest() pins platform='messenger'; re-platform via raw SQL.
  const setPlatform = (id, platform) =>
    dataSource.query(
      `UPDATE webhook_inbound_events SET platform = $1 WHERE id = $2`,
      [platform, id],
    );

  const mPending = await seed('smoke-m-pending');
  const mFailedDue = await seed('smoke-m-failed-due', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'failed', retry_count = 1,
       next_retry_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
  });
  await seed('smoke-m-failed-future', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'failed', retry_count = 1,
       next_retry_at = now() + interval '1 hour' WHERE id = $1`,
      [id],
    );
  });
  const mFailedNull = await seed('smoke-m-failed-null', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'failed', retry_count = 1,
       next_retry_at = NULL WHERE id = $1`,
      [id],
    );
  });
  const mStale = await seed('smoke-m-stale', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'processing',
       updated_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
  });
  await seed('smoke-m-fresh', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'processing' WHERE id = $1`,
      [id],
    );
  });
  await seed('smoke-m-done', null, async (id) => {
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'completed' WHERE id = $1`,
      [id],
    );
  });
  // Cross-platform rows: with a broken (unparenthesized) OR these leak into
  // the messenger result — the #445 regression shape.
  await seed('smoke-z-pending', null, async (id) => setPlatform(id, 'zalo'));
  await seed('smoke-z-stale', null, async (id) => {
    await setPlatform(id, 'zalo');
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'processing',
       updated_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
  });
  await seed('smoke-d-failed', null, async (id) => {
    await setPlatform(id, 'discord');
    await dataSource.query(
      `UPDATE webhook_inbound_events SET status = 'failed', retry_count = 1,
       next_retry_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );
  });

  const opts = { limit: 100, processingStuckMs: 60_000 };
  const due = await messenger.listDue(opts);
  assert.deepEqual(
    due.map((r) => r.id),
    [mPending, mFailedDue, mFailedNull, mStale],
    `unexpected due set: ${JSON.stringify(due.map((r) => r.id))}`,
  );
  console.log('  ok: due-state matrix (pending/failed-due/failed-null/stale)');

  assert.equal(
    await messenger.countDue(opts),
    due.length,
    'countDue disagrees with listDue',
  );
  console.log('  ok: countDue matches listDue');

  const zDue = await zalo.listDue(opts);
  assert.deepEqual(
    zDue.map((r) => r.eventId).sort(),
    ['smoke-z-pending', 'smoke-z-stale'],
    `unexpected zalo due set: ${JSON.stringify(zDue.map((r) => r.eventId))}`,
  );
  console.log('  ok: platform isolation both directions');
}

async function quotaSuite() {
  console.log('quota: idempotency ON CONFLICT DO NOTHING returns zero rows');
  // Own DataSource: chat-metering ships its own entity classes for these
  // tables, which must not share metadata with the registry classes above.
  const quotaDs = new DataSource({
    ...dataSourceOptions(),
    entities: [QuotaDailyUsageEntity, QuotaIdempotencyEntity],
  });
  await quotaDs.initialize();
  try {
    const repo = new ChatRateLimitRepository(
      quotaDs.getRepository(QuotaDailyUsageEntity),
      quotaDs.getRepository(QuotaIdempotencyEntity),
      'messenger',
    );
    const input = {
      idempotencyKey: 'smoke-quota-1',
      externalUserId: 'smoke-quota-user',
      usageDate: '2026-09-01',
    };
    const first = await repo.tryReserveIdempotency(input);
    assert.ok(first, 'first reserve should insert');
    assert.equal(first.idempotencyKey, 'smoke-quota-1');
    // Same key again: ON CONFLICT DO NOTHING yields zero rows → null (the
    // #444-family shape — a flat [] here, never a tuple).
    const second = await repo.tryReserveIdempotency(input);
    assert.equal(second, null, 'conflicting reserve should return null');
    // A different key still reserves: the conflict is key-scoped, not broken.
    const third = await repo.tryReserveIdempotency({
      ...input,
      idempotencyKey: 'smoke-quota-2',
    });
    assert.ok(third, 'distinct key should insert');
    console.log('  ok: double reserve → null, distinct key inserts');
  } finally {
    await quotaDs.query(
      `DELETE FROM chat_idempotency WHERE idempotency_key LIKE 'smoke-quota-%'`,
    );
    if (quotaDs.isInitialized) await quotaDs.destroy();
  }
}

async function luaSuite() {
  console.log('lua: burst + slot negative paths on real Redis');
  const IORedis = require('ioredis');
  redis = new IORedis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
  });
  await redis.connect();
  const port = redisClientPort(redis);

  // Burst: over-limit rejects, concurrent reserves split exactly at limit,
  // and a deleted key resets the count.
  const burst = new RedisBurstCounter(port, { platform: 'test' });
  const r1 = await burst.tryReserveBurst('smoke-burst-1', 3);
  const r2 = await burst.tryReserveBurst('smoke-burst-1', 3);
  const r3 = await burst.tryReserveBurst('smoke-burst-1', 3);
  const r4 = await burst.tryReserveBurst('smoke-burst-1', 3);
  assert.deepEqual(
    [r1, r2, r3, r4].map((r) => r.allowed),
    [true, true, true, false],
    'burst over-limit must reject the 4th reserve',
  );
  assert.deepEqual(
    [r1, r2, r3].map((r) => r.count),
    [1, 2, 3],
  );
  console.log('  ok: burst over-limit rejects with counts 1..3');

  const raced = await Promise.all(
    Array.from({ length: 10 }, () =>
      burst.tryReserveBurst('smoke-burst-race', 5),
    ),
  );
  assert.equal(
    raced.filter((r) => r.allowed).length,
    5,
    'concurrent reserves must split exactly at the limit',
  );
  console.log('  ok: concurrent burst race splits exactly at limit');

  await delKeys(redis, 'burst:*smoke-burst-*');
  const reset = await burst.tryReserveBurst('smoke-burst-1', 3);
  assert.deepEqual([reset.allowed, reset.count], [true, 1]);
  console.log('  ok: deleted key resets the count');

  // Slot: over-limit throws, stale release is a no-op, expiry frees.
  const slotKey = 'smoke:llm:slots';
  const releaseA = await acquireRedisSlot(redis, slotKey, 1, noopLogger, {
    leaseMs: 60_000,
    maxRetries: 1,
    waitBudgetMs: 300,
  });
  await assert.rejects(
    acquireRedisSlot(redis, slotKey, 1, noopLogger, {
      maxRetries: 1,
      waitBudgetMs: 300,
    }),
    (err) =>
      err instanceof LlmOverloadError && err.reason === 'global_saturated',
    'second acquire must throw global_saturated',
  );
  console.log('  ok: slot over-limit throws LlmOverloadError');

  // Simulate a stale worker: its lease key is gone, so its release must not
  // free the slot another owner holds.
  const leaseKeys = await redis.keys(`${slotKey}:lease:*`);
  assert.equal(leaseKeys.length, 1, 'expected exactly one lease key');
  await redis.del(...leaseKeys);
  await releaseA();
  await assert.rejects(
    acquireRedisSlot(redis, slotKey, 1, noopLogger, {
      maxRetries: 1,
      waitBudgetMs: 300,
    }),
    (err) => err instanceof LlmOverloadError,
    'stale release must not free the counter',
  );
  console.log('  ok: stale release is a no-op');
  await delKeys(redis, 'smoke:llm:slots*');

  const releaseE = await acquireRedisSlot(redis, slotKey, 1, noopLogger, {
    leaseMs: 300,
  });
  await sleep(700);
  const releaseF = await acquireRedisSlot(redis, slotKey, 1, noopLogger, {
    maxRetries: 1,
    waitBudgetMs: 300,
  });
  await releaseE();
  await releaseF();
  console.log('  ok: expired lease frees the slot');
  await delKeys(redis, 'smoke:llm:slots*');
}

async function privacyRollbackSuite() {
  console.log('privacy: mid-transaction failure rolls back everything');
  const service = new PrivacyDataService(dataSource, registry);
  const externalUserId = 'smoke-rollback-1';
  const userId = 4242442;
  const date = '2026-09-01';
  const now = new Date();

  await dataSource.getRepository(registry.mappings.messenger).insert({
    platform: 'messenger',
    externalUserId,
    userId,
    notificationMessagesToken: `smoke-token-${externalUserId}`,
    cadence: null,
    topic: null,
    status: 'ACTIVE',
    linkState: 'active',
    mappingGeneration: '1',
  });
  const scoped = registry.scoped;
  await dataSource.getRepository(scoped.learnerProfile).insert({
    platform: 'messenger',
    externalUserId,
    userId,
    targetScore: 7,
    examDate: '2026-12-31',
    targetScoreFetchedAt: now,
    examDateFetchedAt: now,
    updatedAt: now,
  });
  await dataSource.getRepository(scoped.studyReminderJob).insert({
    platform: 'messenger',
    externalUserId,
    userId,
    sessionKey: `smoke-session-${externalUserId}`,
    scheduledAt: now,
    remindAt: now,
  });
  await dataSource.getRepository(scoped.chatDailyUsage).insert({
    platform: 'messenger',
    externalUserId,
    userId,
    usageDate: date,
  });
  await dataSource.getRepository(scoped.chatIdempotency).insert({
    idempotencyKey: `smoke-idempotency-${externalUserId}`,
    platform: 'messenger',
    externalUserId,
    userId,
    usageDate: date,
  });

  // Fault trigger on a LATE-deleted table: everything delete() removed
  // before reaching it (mapping, learnerProfile, studyReminderJob,
  // chatDailyUsage, ...) must roll back.
  const idemTable = dataSource.getMetadata(scoped.chatIdempotency).tableName;
  await dataSource.query(
    `CREATE OR REPLACE FUNCTION smoke_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'smoke-induced rollback'; END $$`,
  );
  await dataSource.query(
    `DROP TRIGGER IF EXISTS smoke_fail_delete_trigger ON "${idemTable}"`,
  );
  await dataSource.query(
    `CREATE TRIGGER smoke_fail_delete_trigger BEFORE DELETE ON "${idemTable}" FOR EACH ROW EXECUTE FUNCTION smoke_fail_delete()`,
  );

  try {
    await assert.rejects(
      service.delete('messenger', externalUserId),
      /smoke-induced rollback/,
      'delete should throw the trigger fault',
    );
    console.log('  ok: faulted delete throws');

    const mapping = await dataSource
      .getRepository(registry.mappings.messenger)
      .findOne({ where: { platform: 'messenger', externalUserId } });
    assert.ok(mapping, 'mapping was not rolled back');
    // Every scoped target delete() touches must show zero partial effects:
    // the four seeded tables keep their row, the rest stay empty, and the
    // audit insert inside the transaction leaves no row behind either.
    const expectedCounts = {
      learnerProfile: 1,
      studyReminderJob: 1,
      scheduledReportClaim: 0,
      learnerScheduledReportClaim: 0,
      reportSendJob: 0,
      chatDailyUsage: 1,
      llmUsageEvent: 0,
      chatIdempotency: 1,
      webActivity: 0,
      notificationPreference: 0,
    };
    for (const [name, expected] of Object.entries(expectedCounts)) {
      const count = await dataSource
        .getRepository(registry.scoped[name])
        .count({ where: { userId } });
      assert.equal(count, expected, `${name}: expected ${expected}, got ${count}`);
    }
    const auditRows = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM platform_link_audit_events
       WHERE external_user_hash = $1`,
      [createHash('sha256').update(externalUserId).digest('hex')],
    );
    assert.equal(
      Number(auditRows[0]?.count ?? -1),
      0,
      'audit insert was not rolled back',
    );
    console.log('  ok: every earlier write rolled back (zero partial effects)');
  } finally {
    await dataSource.query(
      `DROP TRIGGER IF EXISTS smoke_fail_delete_trigger ON "${idemTable}"`,
    );
    await dataSource.query(`DROP FUNCTION IF EXISTS smoke_fail_delete()`);
  }
}

async function cleanup() {
  await dataSource.query(
    `DELETE FROM cron_leader_leases WHERE name LIKE 'smoke-%'`,
  );
  await dataSource.query(
    `DELETE FROM webhook_inbound_events WHERE event_id LIKE 'smoke-%'`,
  );
  const EXT = 'smoke-rollback-1';
  const UID = 4242442;
  await dataSource
    .getRepository(registry.mappings.messenger)
    .delete({ platform: 'messenger', externalUserId: EXT });
  for (const target of Object.values(registry.scoped)) {
    try {
      await dataSource.getRepository(target).delete({ userId: UID });
    } catch {
      // best effort — tables without a userId column fall through here
    }
  }
  if (redis) {
    await delKeys(redis, 'burst:*smoke-burst*');
    await delKeys(redis, 'smoke:llm:slots*');
  }
}

try {
  dataSource = new DataSource(dataSourceOptions());
  await dataSource.initialize();
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "messenger_link_verify_records" (
      "psid" varchar(64) PRIMARY KEY,
      "user_id" integer NOT NULL,
      "verified_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await leaseSuite();
  await inboxSuite();
  await quotaSuite();
  await luaSuite();
  await privacyRollbackSuite();
  console.log('persistence semantics smoke: all suites pinned');
} finally {
  try {
    if (dataSource?.isInitialized) await cleanup().catch(() => {});
  } catch {
    // best effort cleanup
  }
  try {
    await dataSource.query(
      `DROP TABLE IF EXISTS "messenger_link_verify_records"`,
    );
  } catch {
    // best effort cleanup
  }
  if (dataSource?.isInitialized) await dataSource.destroy();
  if (redis) await redis.quit();
}
