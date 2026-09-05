import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

/**
 * Real-Postgres regression smoke for study-reminder delivery outcomes (#797).
 * The fake sender proves the adapter contract; the repository exercises the
 * lease, terminal-outcome, and schedule-generation races against PostgreSQL.
 *
 * Usage: npm run study-reminder:delivery-smoke
 * Requires NODE_ENV=test and a loopback PostgreSQL (same contract as the
 * database bootstrap smoke). The script deletes only its own random rows.
 */

const require = createRequire(import.meta.url);
const { DataSource } = require('typeorm');
const {
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
  StudyReminderDispatchService,
  wrapMessageSender,
} = require('@wispace/study-reminder-shared');

for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
  if (!process.env[key]?.trim()) {
    throw new Error(`study-reminder delivery smoke requires ${key}`);
  }
}
if (
  process.env.NODE_ENV !== 'test' ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.DB_HOST.trim().toLowerCase(),
  )
) {
  throw new Error(
    'study-reminder delivery smoke requires NODE_ENV=test and a loopback DB_HOST',
  );
}

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: false,
  logging: false,
  entities: [StudyReminderJobEntity],
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function input(externalUserId, sessionKey, scheduledAt, remindAt) {
  return {
    platform: 'messenger',
    externalUserId,
    userId: 7,
    sessionKey,
    scheduledAt,
    remindAt,
    topic: 'integration smoke',
    maxRetries: 3,
  };
}

async function rowById(id) {
  const rows = await dataSource.query(
    `SELECT id, status, delivery_key, delivery_status, lease_token,
            lease_expires_at, processing_started_at, scheduled_at
       FROM study_reminder_jobs
      WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function dispatchSchedule() {
  return {
    getOutboxSettings: () => ({
      timezone: 'Asia/Ho_Chi_Minh',
      minutesBefore: 30,
      minLeadMinutes: 1,
      syncHorizonHours: 168,
      eveningRolloverHour: 23,
      stuckProcessingMs: 600_000,
      leaseMs: 600_000,
      jobRetentionDays: 7,
      maxRetries: 3,
      retryBackoffMinutes: 2,
    }),
    isSessionStarted: () => false,
    formatScheduledTimeLabel: () => 'Hôm nay lúc 10:00',
    getMinutesUntilSession: () => 10,
  };
}

const owner = `smoke-${randomUUID().replaceAll('-', '')}`;
const now = Date.now();
const future = new Date(now + 60 * 60 * 1000);
const due = new Date(now - 60 * 1000);

try {
  await dataSource.initialize();
  const jobRepository = new TypeormStudyReminderJobRepository(
    dataSource.getRepository(StudyReminderJobEntity),
  );

  // Sender adapter: explicit outcomes survive unchanged and typed provider
  // ambiguity is normalized without leaking a throw to the dispatcher.
  const ambiguousSender = wrapMessageSender({
    sendText: async () => 'ambiguous',
  });
  const notSentSender = wrapMessageSender({
    sendText: async () => 'not_sent',
  });
  assert(
    (await ambiguousSender.sendText({ externalUserId: owner, text: 'x' })) ===
      'ambiguous',
    'adapter lost explicit ambiguous outcome',
  );
  assert(
    (await notSentSender.sendText({ externalUserId: owner, text: 'x' })) ===
      'not_sent',
    'adapter lost explicit not_sent outcome',
  );

  // Direct terminal outcomes are persisted and excluded from due/claim.
  const terminalJob = await jobRepository.upsertPendingJob(
    input(owner, 'smoke-terminal', future, due),
  );
  const terminalClaim = await jobRepository.claimJob(
    'messenger',
    terminalJob.id,
    600_000,
  );
  assert(terminalClaim?.leaseToken, 'terminal job was not claimed');
  await jobRepository.markFailed({
    jobId: terminalJob.id,
    leaseToken: terminalClaim.leaseToken,
    errorMessage: 'outbound rate limit',
    retryCount: 1,
    terminal: true,
    deliveryStatus: 'rate_limited',
  });
  assert(
    (await jobRepository.findDueJobs('messenger', new Date(), 1)).every(
      (job) => job.id !== terminalJob.id,
    ),
    'terminal rate-limited job re-entered due queue',
  );
  assert(
    (await jobRepository.claimJob('messenger', terminalJob.id, 600_000)) ===
      null,
    'terminal rate-limited job remained claimable',
  );
  const terminalRow = await rowById(terminalJob.id);
  assert(
    terminalRow.delivery_status === 'rate_limited' &&
      terminalRow.lease_token === null,
    'terminal outcome or lease was not persisted atomically',
  );

  // Exercise the actual dispatcher against PostgreSQL: a provider ack followed
  // by a finalization crash becomes ambiguous instead of retryable.
  const dispatchCrashJob = await jobRepository.upsertPendingJob(
    input(owner, 'smoke-dispatch-crash', future, due),
  );
  let dispatchProviderCalls = 0;
  const failingFinalizationRepository = new Proxy(jobRepository, {
    get(target, property, receiver) {
      if (property === 'markSent') {
        return async () => {
          throw new Error('simulated finalization crash');
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const dispatchCrashService = new StudyReminderDispatchService(
    failingFinalizationRepository,
    {
      sendText: async () => {
        dispatchProviderCalls += 1;
        return 'sent';
      },
    },
    dispatchSchedule(),
    'messenger',
    { generateReminder: async () => 'provider-accepted reminder' },
    { backoffMode: 'flat' },
  );
  const dispatchCrashResult = await dispatchCrashService.dispatchDueReminders();
  assert(
    dispatchCrashResult.failed === 1,
    'dispatcher did not surface finalization failure',
  );
  assert(dispatchProviderCalls === 1, 'provider was not called exactly once');
  const dispatchCrashRow = await rowById(dispatchCrashJob.id);
  assert(
    dispatchCrashRow.status === 'failed' &&
      dispatchCrashRow.delivery_status === 'ambiguous' &&
      dispatchCrashRow.lease_token === null,
    'provider ack followed by finalization failure was not terminalized as ambiguous',
  );

  // Provider accepted, worker crashed before markSent: recovery marks the
  // row ambiguous, clears the lease, and stale finalization cannot win.
  const crashJob = await jobRepository.upsertPendingJob(
    input(owner, 'smoke-crash', future, due),
  );
  const crashClaim = await jobRepository.claimJob(
    'messenger',
    crashJob.id,
    600_000,
  );
  assert(crashClaim?.leaseToken, 'crash job was not claimed');
  await jobRepository.markDeliveryKey(
    crashJob.id,
    crashClaim.leaseToken,
    'smoke-crash-key',
  );
  await dataSource.query(
    `UPDATE study_reminder_jobs
        SET lease_expires_at = now() - interval '1 second'
      WHERE id = $1`,
    [crashJob.id],
  );
  const resetCount = await jobRepository.resetStuckProcessingJobs(
    'messenger',
    new Date(now - 600_000),
  );
  assert(resetCount >= 1, 'expired processing job was not recovered');
  const recoveredRow = await rowById(crashJob.id);
  assert(
    recoveredRow.delivery_status === 'ambiguous' &&
      recoveredRow.lease_token === null &&
      recoveredRow.lease_expires_at === null,
    'recovery did not preserve ambiguous outcome and clear lease',
  );
  assert(
    (await jobRepository.findDueJobs('messenger', new Date(), 1)).every(
      (job) => job.id !== crashJob.id,
    ),
    'recovered ambiguous job re-entered due queue',
  );
  assert(
    (await jobRepository.claimJob('messenger', crashJob.id, 600_000)) === null,
    'recovered ambiguous job remained claimable',
  );
  assert(
    (await jobRepository.countTerminalFailedSince(new Date(now - 600_000))) >=
      2,
    'recovered ambiguous outcome was not visible to operator queries',
  );
  await jobRepository.markSent(
    crashJob.id,
    crashClaim.leaseToken,
    'stale-provider-record',
    'smoke-crash-key',
  );
  const staleRow = await rowById(crashJob.id);
  assert(
    staleRow.status === 'failed' && staleRow.delivery_status === 'ambiguous',
    'stale worker finalized a recovered ambiguous job',
  );

  // Same session key, changed schedule: reopen fences the old owner and
  // clears the previous generation key; the new owner can send once.
  const raceJob = await jobRepository.upsertPendingJob(
    input(owner, 'smoke-reschedule', future, due),
  );
  const oldClaim = await jobRepository.claimJob(
    'messenger',
    raceJob.id,
    600_000,
  );
  assert(oldClaim?.leaseToken, 'reschedule job was not claimed');
  await jobRepository.markDeliveryKey(
    raceJob.id,
    oldClaim.leaseToken,
    'old-generation-key',
  );
  const changedAt = new Date(now + 2 * 60 * 60 * 1000);
  await jobRepository.upsertPendingJob(
    input(owner, 'smoke-reschedule', changedAt, new Date(now - 60 * 1000)),
    { reopenOnlyOnScheduleChange: true },
  );
  const reopenedRow = await rowById(raceJob.id);
  assert(
    reopenedRow.status === 'pending' &&
      reopenedRow.delivery_key === null &&
      reopenedRow.delivery_status === null &&
      reopenedRow.lease_token === null,
    'schedule reopen did not clear the previous generation',
  );
  await jobRepository.markSent(
    raceJob.id,
    oldClaim.leaseToken,
    'stale-provider-record',
    'old-generation-key',
  );
  const fencedRow = await rowById(raceJob.id);
  assert(fencedRow.status === 'pending', 'stale owner finalized reopened job');
  const newClaim = await jobRepository.claimJob(
    'messenger',
    raceJob.id,
    600_000,
  );
  assert(newClaim?.leaseToken, 'new schedule could not be claimed');
  await jobRepository.markDeliveryKey(
    raceJob.id,
    newClaim.leaseToken,
    'new-generation-key',
  );
  await jobRepository.markSent(
    raceJob.id,
    newClaim.leaseToken,
    'new-provider-record',
    'new-generation-key',
  );
  const sentRow = await rowById(raceJob.id);
  assert(
    sentRow.status === 'sent' &&
      sentRow.delivery_status === 'sent' &&
      sentRow.delivery_key === 'new-generation-key',
    'new schedule did not finalize as sent',
  );

  // Run the same reschedule race through the dispatcher. Reopening while the
  // old worker is building text clears its lease before the provider call.
  const dispatchRaceJob = await jobRepository.upsertPendingJob(
    input(owner, 'smoke-dispatch-reschedule', future, due),
  );
  let releaseGeneration;
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  let oldGenerationProviderCalls = 0;
  const oldGenerationService = new StudyReminderDispatchService(
    jobRepository,
    {
      sendText: async () => {
        oldGenerationProviderCalls += 1;
        return 'sent';
      },
    },
    dispatchSchedule(),
    'messenger',
    {
      generateReminder: async () => {
        await generationGate;
        return 'old generation';
      },
    },
    { backoffMode: 'flat' },
  );
  const oldGenerationDispatch = oldGenerationService.dispatchDueReminders();
  await waitUntil(
    async () => (await rowById(dispatchRaceJob.id))?.status === 'processing',
    'old generation did not claim the reschedule race job',
  );
  await jobRepository.upsertPendingJob(
    input(
      owner,
      'smoke-dispatch-reschedule',
      new Date(now + 2 * 60 * 60 * 1000),
      new Date(now - 60 * 1000),
    ),
    { reopenOnlyOnScheduleChange: true },
  );
  releaseGeneration();
  await oldGenerationDispatch;
  assert(
    oldGenerationProviderCalls === 0,
    'stale generation called provider after schedule reopen',
  );
  const newGenerationService = new StudyReminderDispatchService(
    jobRepository,
    {
      sendText: async () => 'sent',
    },
    dispatchSchedule(),
    'messenger',
    { generateReminder: async () => 'new generation' },
    { backoffMode: 'flat' },
  );
  const newGenerationResult = await newGenerationService.dispatchDueReminders();
  assert(newGenerationResult.sent === 1, 'new schedule did not dispatch');
  const dispatchRaceRow = await rowById(dispatchRaceJob.id);
  assert(
    dispatchRaceRow.status === 'sent' &&
      dispatchRaceRow.delivery_status === 'sent',
    'new generation did not finalize as sent',
  );

  console.log('study-reminder delivery smoke: all #797 checks passed');
} finally {
  try {
    await dataSource.query(
      'DELETE FROM study_reminder_jobs WHERE external_user_id = $1',
      [owner],
    );
  } catch {
    // Best-effort cleanup; preserve the original assertion/connection error.
  }
  if (dataSource.isInitialized) await dataSource.destroy();
}
