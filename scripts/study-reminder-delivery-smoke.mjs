import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

/**
 * Real-Postgres regression smoke for study-reminder delivery outcomes (#797)
 * and Messenger reminder consent selection/suppression (#942).
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
  StudyReminderSyncService,
  wrapMessageSender,
} = require('@wispace/study-reminder-shared/adapters');
const {
  UserNotificationPreferenceEntity,
  UserPlatformMappingEntity,
} = require('@wispace/database');
const {
  MessengerRepository,
} = require('../apps/messenger-bot/dist/modules/messenger/infrastructure/persistence/messenger.repository.js');

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
  entities: [
    StudyReminderJobEntity,
    UserPlatformMappingEntity,
    UserNotificationPreferenceEntity,
  ],
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function input(externalUserId, sessionKey, scheduledAt, remindAt) {
  return {
    platform: 'messenger',
    externalUserId,
    userId: 7,
    mappingGeneration: '1',
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

async function exerciseMessengerReminderConsent(jobRepository) {
  const suffix = randomUUID().replaceAll('-', '');
  const prefix = `consent-${suffix}`;
  const baseUserId = 1_800_000_000 + Math.floor(Math.random() * 100_000);
  const learners = [
    {
      userId: baseUserId,
      externalUserId: `${prefix}-false`,
      reminderEnabled: false,
    },
    {
      userId: baseUserId + 1,
      externalUserId: `${prefix}-true`,
      reminderEnabled: true,
    },
    {
      userId: baseUserId + 2,
      externalUserId: `${prefix}-null`,
      reminderEnabled: null,
    },
  ];
  const userIds = learners.map(({ userId }) => userId);
  const externalUserIds = learners.map(({ externalUserId }) => externalUserId);
  const mappingRepo = dataSource.getRepository(UserPlatformMappingEntity);
  const messengerRepository = new MessengerRepository(mappingRepo, {}, {});
  const [{ max_id: mappingStartId }] = await dataSource.query(
    'SELECT COALESCE(MAX(id), 0) AS max_id FROM user_platform_mappings',
  );

  try {
    await dataSource.query(
      `INSERT INTO user_platform_mappings
        (user_id, platform, external_user_id, notification_messages_token,
         status, link_state, mapping_generation)
       VALUES
        ($1, 'messenger', $2, $3, 'ACTIVE', 'active', '1'),
        ($4, 'messenger', $5, $6, 'ACTIVE', 'active', '1'),
        ($7, 'messenger', $8, $9, 'ACTIVE', 'active', '1')`,
      [
        learners[0].userId,
        learners[0].externalUserId,
        `${prefix}-token-false`,
        learners[1].userId,
        learners[1].externalUserId,
        `${prefix}-token-true`,
        learners[2].userId,
        learners[2].externalUserId,
        `${prefix}-token-null`,
      ],
    );
    await dataSource.query(
      `INSERT INTO user_notification_preferences (user_id, reminder_enabled)
       VALUES ($1, $2), ($3, $4), ($5, $6)`,
      [
        learners[0].userId,
        learners[0].reminderEnabled,
        learners[1].userId,
        learners[1].reminderEnabled,
        learners[2].userId,
        learners[2].reminderEnabled,
      ],
    );

    // Real QueryBuilder execution: false is excluded, true and NULL remain.
    const selected = await messengerRepository.findActiveMappingsPage(
      Number(mappingStartId),
      100,
    );
    const selectedIds = new Set(
      selected.map((mapping) => mapping.psid).filter(Boolean),
    );
    assert(
      !selectedIds.has(learners[0].externalUserId),
      'real PostgreSQL selection included reminder opt-out',
    );
    assert(
      selectedIds.has(learners[1].externalUserId),
      'real PostgreSQL selection excluded explicit reminder opt-in',
    );
    assert(
      selectedIds.has(learners[2].externalUserId),
      'real PostgreSQL selection excluded NULL reminder preference',
    );

    const mappingReader = {
      findActiveMappingsPage: async (platform, query) => {
        const mappings = await messengerRepository.findActiveMappingsPage(
          Number(query.afterId ?? mappingStartId),
          query.limit,
        );
        return {
          items: mappings
            .filter((mapping) => mapping.psid && mapping.userId != null)
            .map((mapping) => ({
              externalUserId: mapping.psid,
              userId: mapping.userId,
              platform,
              mappingGeneration: mapping.mappingGeneration,
            })),
          nextId:
            mappings.length > 0
              ? String(mappings[mappings.length - 1].id)
              : undefined,
        };
      },
      findActiveMappingByExternalUserId: async (_platform, externalUserId) => {
        const mapping =
          await messengerRepository.findActiveMappingByPsid(externalUserId);
        return mapping?.psid && mapping.userId != null
          ? {
              externalUserId: mapping.psid,
              userId: mapping.userId,
              platform: 'messenger',
              mappingGeneration: mapping.mappingGeneration,
            }
          : null;
      },
      getMappingState: async (_platform, externalUserId) => {
        const mapping =
          await messengerRepository.findActiveMappingByPsid(externalUserId);
        return mapping?.psid && mapping.userId != null
          ? {
              state: 'active',
              userId: mapping.userId,
              mappingGeneration: mapping.mappingGeneration,
            }
          : null;
      },
    };
    const schedule = {
      ...dispatchSchedule(),
      computeRemindAt: () => new Date(Date.now() - 60_000),
    };
    const syncService = new StudyReminderSyncService(
      mappingReader,
      jobRepository,
      schedule,
      undefined,
      async () => 'messenger',
    );
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    const syncResult = await syncService.syncUpcomingSessions({
      platform: 'messenger',
      getSessions: async (_externalUserId, userId) => [
        {
          sessionKey: `${prefix}-session-${userId}`,
          scheduledAt,
          topic: 'consent smoke',
        },
      ],
    });
    assert(
      syncResult.mappings === 2 && syncResult.upserted === 2,
      `sync admitted the wrong reminder population: ${JSON.stringify(syncResult)}`,
    );

    const jobs = await dataSource.query(
      `SELECT external_user_id, status
         FROM study_reminder_jobs
        WHERE external_user_id = ANY($1::text[])`,
      [externalUserIds],
    );
    assert(
      jobs.length === 2 &&
        jobs.every(({ external_user_id }) =>
          externalUserIds.slice(1).includes(external_user_id),
        ),
      'opted-out learner created a reminder job during sync',
    );

    const outboundAttempts = [];
    const sendAttempts = new Map();
    const dispatchService = new StudyReminderDispatchService(
      jobRepository,
      {
        sendText: async ({ externalUserId }) => {
          outboundAttempts.push(externalUserId);
          const attempt = (sendAttempts.get(externalUserId) ?? 0) + 1;
          sendAttempts.set(externalUserId, attempt);
          return externalUserId === learners[1].externalUserId && attempt === 1
            ? 'not_sent'
            : 'sent';
        },
      },
      schedule,
      'messenger',
      { generateReminder: async () => 'consent smoke reminder' },
      {
        concurrencyLimit: 3,
        getMappingState: (externalUserId) =>
          mappingReader.getMappingState('messenger', externalUserId),
        backoffMode: 'flat',
      },
    );
    const dispatchResult = await dispatchService.dispatchDueReminders();
    assert(
      dispatchResult.sent === 1 &&
        dispatchResult.retried === 1 &&
        new Set(outboundAttempts).size === 2 &&
        outboundAttempts.every((id) => externalUserIds.slice(1).includes(id)),
      `dispatch did not preserve the eligible send path: ${JSON.stringify({ dispatchResult, outboundAttempts })}`,
    );
    const failedRetry = await dataSource.query(
      `SELECT status
         FROM study_reminder_jobs
        WHERE external_user_id = $1`,
      [learners[1].externalUserId],
    );
    assert(
      failedRetry[0]?.status === 'failed',
      'eligible learner did not enter the normal retry path',
    );
    await dataSource.query(
      `UPDATE study_reminder_jobs
          SET next_retry_at = NOW() - INTERVAL '1 second'
        WHERE external_user_id = $1`,
      [learners[1].externalUserId],
    );
    const retryResult = await dispatchService.dispatchDueReminders();
    assert(
      retryResult.sent === 1 &&
        sendAttempts.get(learners[1].externalUserId) === 2 &&
        sendAttempts.get(learners[2].externalUserId) === 1,
      `eligible learner retry did not send normally: ${JSON.stringify({ retryResult, sendAttempts: [...sendAttempts] })}`,
    );
    assert(
      !outboundAttempts.includes(learners[0].externalUserId),
      'opted-out learner reached the outbound sender',
    );
    console.log(
      'messenger reminder consent: real PostgreSQL selection + sync/dispatch passed (#942)',
    );
  } finally {
    await dataSource.query(
      `DELETE FROM study_reminder_jobs WHERE external_user_id = ANY($1::text[])`,
      [externalUserIds],
    );
    await dataSource.query(
      `DELETE FROM user_notification_preferences WHERE user_id = ANY($1::int[])`,
      [userIds],
    );
    await dataSource.query(
      `DELETE FROM user_platform_mappings WHERE external_user_id = ANY($1::text[])`,
      [externalUserIds],
    );
  }
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

  await exerciseMessengerReminderConsent(jobRepository);

  await dataSource.query(
    `INSERT INTO user_platform_mappings
      (user_id, platform, external_user_id, notification_messages_token,
       status, link_state, mapping_generation)
     VALUES (7, 'messenger', $1, $2, 'ACTIVE', 'active', '1')`,
    [owner, `${owner}-token`],
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
  const [terminalJob] = await jobRepository.upsertPendingJobs([
    input(owner, 'smoke-terminal', future, due),
  ]);
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
  const [dispatchCrashJob] = await jobRepository.upsertPendingJobs([
    input(owner, 'smoke-dispatch-crash', future, due),
  ]);
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
    { concurrencyLimit: 3, backoffMode: 'flat' },
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
  const [crashJob] = await jobRepository.upsertPendingJobs([
    input(owner, 'smoke-crash', future, due),
  ]);
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
  const [raceJob] = await jobRepository.upsertPendingJobs([
    input(owner, 'smoke-reschedule', future, due),
  ]);
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
  await jobRepository.upsertPendingJobs(
    [input(owner, 'smoke-reschedule', changedAt, new Date(now - 60 * 1000))],
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
  const [dispatchRaceJob] = await jobRepository.upsertPendingJobs([
    input(owner, 'smoke-dispatch-reschedule', future, due),
  ]);
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
    { concurrencyLimit: 3, backoffMode: 'flat' },
  );
  const oldGenerationDispatch = oldGenerationService.dispatchDueReminders();
  await waitUntil(
    async () => (await rowById(dispatchRaceJob.id))?.status === 'processing',
    'old generation did not claim the reschedule race job',
  );
  await jobRepository.upsertPendingJobs(
    [
      input(
        owner,
        'smoke-dispatch-reschedule',
        new Date(now + 2 * 60 * 60 * 1000),
        new Date(now - 60 * 1000),
      ),
    ],
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
    { concurrencyLimit: 3, backoffMode: 'flat' },
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
    await dataSource.query(
      'DELETE FROM user_platform_mappings WHERE external_user_id = $1',
      [owner],
    );
  } catch {
    // Best-effort cleanup; preserve the original assertion/connection error.
  }
  if (dataSource.isInitialized) await dataSource.destroy();
}
