import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import type { StudyReminderJobRepositoryPort } from '../ports/study-reminder-job.repository.port';
import type { MessageSenderPort } from '../ports/message-sender.port';
import type { DispatchHooksPort } from '../ports/dispatch-hooks.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import type { StudyReminderJob } from '../types/study-reminder.types';

describe('StudyReminderDispatchService', () => {
  let service: StudyReminderDispatchService;
  let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
  let messageSender: jest.Mocked<MessageSenderPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let hooks: jest.Mocked<DispatchHooksPort>;
  let options: {
    backoffMode: 'exponential' | 'flat';
    preloadDisplayNames: jest.Mock;
    classifyFailure: jest.Mock;
    rng?: () => number;
  };

  const defaultSettings = {
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
  };

  function makeJob(
    overrides: Partial<StudyReminderJob> = {},
  ): StudyReminderJob {
    return {
      id: 1,
      platform: 'messenger',
      externalUserId: 'ext-1',
      userId: 42,
      sessionKey: 'calendar:99',
      scheduledAt: new Date('2026-06-27T10:00:00Z'),
      remindAt: new Date('2026-06-27T09:30:00Z'),
      topic: 'Toán',
      status: 'processing',
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    jobRepo = {
      resetStuckProcessingJobs: jest.fn().mockResolvedValue(0),
      findDueJobs: jest.fn().mockResolvedValue([]),
      claimJob: jest.fn().mockResolvedValue(null),
      markCancelled: jest.fn().mockResolvedValue(undefined),
      markSent: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(undefined),
      markDeliveryKey: jest.fn().mockResolvedValue(true),
      findNextDueTime: jest.fn().mockResolvedValue(null),
      upsertPendingJob: jest.fn(),
      cancelStaleJobsForExternalUserId: jest.fn(),
      cancelJobsFromOtherPlatforms: jest.fn(),
      deleteSentJobs: jest.fn(),
      deleteTerminalJobsOlderThan: jest.fn(),
      countJobsByStatus: jest.fn(),
      countTerminalFailedSince: jest.fn(),
      countStuckProcessing: jest.fn(),
      findTerminalFailedSince: jest.fn(),
      findStuckProcessing: jest.fn(),
    };

    messageSender = { sendText: jest.fn().mockResolvedValue('sent') };

    scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
      getDispatchSettings: jest.fn(),
      computeRemindAt: jest.fn(),
      getMinutesUntilSession: jest.fn().mockReturnValue(10),
      isSessionStarted: jest.fn().mockReturnValue(false),
      formatScheduledTimeLabel: jest.fn().mockReturnValue('Hôm nay lúc 10:00'),
    } as unknown as jest.Mocked<StudyReminderScheduleService>;

    hooks = {
      generateReminder: jest.fn().mockResolvedValue('Nhắc nhở học toán!'),
      onSent: jest.fn(),
    };

    options = {
      backoffMode: 'flat',
      preloadDisplayNames: jest.fn().mockResolvedValue(undefined),
      classifyFailure: jest.fn().mockReturnValue(undefined),
      rng: () => 1, // pin equal-jitter to its ceiling: next_retry_at == nominal
    };
  });

  function build(): void {
    service = new StudyReminderDispatchService(
      jobRepo,
      messageSender,
      scheduleService,
      'messenger',
      hooks,
      options,
    );
  }

  it('returns zero counts and empty failures when no due jobs exist', async () => {
    build();
    const result = await service.dispatchDueReminders();

    expect(result).toMatchObject({
      claimed: 0,
      sent: 0,
      cancelled: 0,
      failed: 0,
      retried: 0,
      resetStuck: 0,
      nextDueAt: null,
      failures: [],
    });
  });

  it('sends reminder and marks job sent on success', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    build();

    const result = await service.dispatchDueReminders();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(messageSender.sendText).toHaveBeenCalledWith({
      externalUserId: 'ext-1',
      text: 'Nhắc nhở học toán!',
      messageType: 'STUDY_REMINDER',
      userId: 42,
      deliveryKey: expect.stringMatching(/^reminder:1:/),
    });
    expect(result).toMatchObject({ claimed: 1, sent: 1, cancelled: 0 });
  });

  it('terminalizes a rate-limited reminder without scheduling a retry', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    messageSender.sendText.mockResolvedValue('rate_limited');
    build();

    const result = await service.dispatchDueReminders();

    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        retryCount: 1,
        errorMessage: 'outbound_rate_limited',
        deliveryStatus: 'rate_limited',
      }),
    );
    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(result.failures).toEqual([
      expect.objectContaining({ error: 'outbound_rate_limited' }),
    ]);
  });

  it('persists an explicit ambiguous outcome and never schedules a retry', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    messageSender.sendText.mockResolvedValue('ambiguous');
    build();

    const result = await service.dispatchDueReminders();

    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        deliveryStatus: 'ambiguous',
        retryCount: 1,
      }),
    );
    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        error: 'ambiguous delivery — not auto-retried',
      }),
    ]);
  });

  it('persists an explicit not_sent outcome and applies normal retry policy', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    messageSender.sendText.mockResolvedValue('not_sent');
    build();

    const result = await service.dispatchDueReminders();

    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: false,
        deliveryStatus: 'not_sent',
        retryCount: 1,
      }),
    );
    expect(result).toMatchObject({ claimed: 1, failed: 0, retried: 1 });
  });

  it('defensively surfaces a terminal row returned by a repository', async () => {
    const job = makeJob({ deliveryStatus: 'ambiguous' });
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    build();

    const result = await service.dispatchDueReminders();

    expect(messageSender.sendText).not.toHaveBeenCalled();
    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        deliveryStatus: 'ambiguous',
      }),
    );
    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        error: 'ambiguous delivery — not auto-retried',
      }),
    ]);
  });

  it('does not retry after provider success when finalization fails', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    jobRepo.markSent.mockRejectedValue(new Error('database unavailable'));
    build();

    const result = await service.dispatchDueReminders();

    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: true,
        deliveryStatus: 'ambiguous',
      }),
    );
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('does not call the provider when the delivery-key lease is lost', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    jobRepo.markDeliveryKey.mockResolvedValue(false);
    build();

    const result = await service.dispatchDueReminders();

    expect(messageSender.sendText).not.toHaveBeenCalled();
    expect(jobRepo.markFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      retried: 0,
    });
  });

  it('does not report sent when finalization loses the lease', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    jobRepo.markSent.mockResolvedValue(false);
    build();

    const result = await service.dispatchDueReminders();

    expect(result).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 0,
      retried: 0,
    });
    expect(hooks.onSent).not.toHaveBeenCalled();
  });

  it.each(['ambiguous', 'rate_limited'] as const)(
    'does not downgrade %s when terminal persistence fails',
    async (outcome) => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockResolvedValue(outcome);
      jobRepo.markFailed.mockRejectedValue(new Error('database unavailable'));
      build();

      const result = await service.dispatchDueReminders();

      expect(jobRepo.markFailed).toHaveBeenCalledTimes(1);
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryStatus: outcome, terminal: true }),
      );
      expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
      expect(result.failures).toEqual([
        expect.objectContaining({
          error:
            outcome === 'ambiguous'
              ? 'ambiguous delivery — not auto-retried'
              : 'outbound_rate_limited',
        }),
      ]);
    },
  );

  it('does not send a claimed reminder after revoke and retries unknown state', async () => {
    const job = makeJob({ leaseToken: 'lease-1' });
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    const getMappingState = jest
      .fn()
      .mockResolvedValueOnce('confirmed-revoked')
      .mockResolvedValueOnce('temporarily-unknown');
    service = new StudyReminderDispatchService(
      jobRepo,
      messageSender,
      scheduleService,
      'messenger',
      hooks,
      { getMappingState },
    );

    const first = await service.dispatchDueReminders();
    expect(first.cancelled).toBe(1);
    expect(messageSender.sendText).not.toHaveBeenCalled();
    expect(jobRepo.markCancelled).toHaveBeenCalledWith(
      1,
      'lease-1',
      'link_confirmed-revoked',
    );

    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    const second = await service.dispatchDueReminders();
    expect(second.retried).toBe(1);
    expect(jobRepo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: false }),
    );
  });

  it('scopes every due/claim/reset query to its own platform (#180)', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const { findDueJobs, claimJob, resetStuckProcessingJobs } = jobRepo;
    findDueJobs.mockResolvedValue([makeJob()]);
    claimJob.mockResolvedValue(makeJob());
    build();

    await service.dispatchDueReminders();

    expect(findDueJobs).toHaveBeenCalledWith(
      'messenger',
      expect.any(Date),
      expect.any(Number),
    );
    expect(claimJob).toHaveBeenCalledWith('messenger', 1, expect.any(Number));
    expect(resetStuckProcessingJobs).toHaveBeenCalledWith(
      'messenger',
      expect.any(Date),
    );
  });

  it('passes jobId to the reminder generator context', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    build();

    await service.dispatchDueReminders();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(hooks.generateReminder).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'calendar:99' }),
      expect.objectContaining({ externalUserId: 'ext-1', jobId: 1 }),
    );
  });

  it('preloads display names in one batch before dispatching', async () => {
    const jobs = [
      makeJob({ id: 1, userId: 10 }),
      makeJob({ id: 2, userId: 10 }),
    ];
    jobRepo.findDueJobs.mockResolvedValue(jobs);
    jobRepo.claimJob.mockResolvedValue(null);
    build();

    await service.dispatchDueReminders();

    expect(options.preloadDisplayNames).toHaveBeenCalledWith([10]);
  });

  it('continues dispatching when preloadDisplayNames fails', async () => {
    const job = makeJob();
    jobRepo.findDueJobs.mockResolvedValue([job]);
    jobRepo.claimJob.mockResolvedValue(job);
    options.preloadDisplayNames.mockRejectedValue(new Error('Redis down'));
    build();

    const result = await service.dispatchDueReminders();

    expect(result.sent).toBe(1);
  });

  describe('flat backoff mode (Messenger)', () => {
    it('schedules a fixed retry delay regardless of retryCount', async () => {
      const job = makeJob({ retryCount: 0, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('Transient'));
      build();

      await service.dispatchDueReminders();

      const expected = new Date(Date.now() + 2 * 60 * 1000);

      const markFailedCall = jobRepo.markFailed.mock.calls[0]?.[0] as {
        terminal?: boolean;
        nextRetryAt?: Date;
      };
      expect(markFailedCall.terminal).toBe(false);
      expect(markFailedCall.nextRetryAt?.getTime()).toBeCloseTo(
        expected.getTime(),
        -3,
      );
    });
  });

  describe('exponential backoff mode (default)', () => {
    it('multiplies backoff by 2^retryCount', async () => {
      options.backoffMode = 'exponential';
      const job = makeJob({ retryCount: 1, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('Transient'));
      build();

      await service.dispatchDueReminders();

      const expected = new Date(Date.now() + 2 * 60 * 1000 * 2);

      const markFailedCall = jobRepo.markFailed.mock.calls[0]?.[0] as {
        nextRetryAt?: Date;
      };
      expect(markFailedCall.nextRetryAt?.getTime()).toBeCloseTo(
        expected.getTime(),
        -3,
      );
    });
  });

  describe('equal jitter on next_retry_at', () => {
    it('spreads the retry within [50%, 100%] of the nominal backoff', async () => {
      delete options.rng; // real Math.random
      const now = Date.now();
      const job = makeJob({ retryCount: 0, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('Transient'));
      build();

      await service.dispatchDueReminders();

      const nominal = 2 * 60 * 1000; // flat mode, retryCount 0
      const markFailedCall = jobRepo.markFailed.mock.calls[0]?.[0] as {
        nextRetryAt?: Date;
      };
      const delay = (markFailedCall.nextRetryAt?.getTime() ?? 0) - now;
      expect(delay).toBeGreaterThanOrEqual(nominal / 2 - 50);
      expect(delay).toBeLessThanOrEqual(nominal);
    });

    it('uses the injected rng deterministically (floor)', async () => {
      options.rng = () => 0;
      const now = Date.now();
      const job = makeJob({ retryCount: 0, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('Transient'));
      build();

      await service.dispatchDueReminders();

      const markFailedCall = jobRepo.markFailed.mock.calls[0]?.[0] as {
        nextRetryAt?: Date;
      };
      const delay = (markFailedCall.nextRetryAt?.getTime() ?? 0) - now;
      expect(delay).toBeGreaterThanOrEqual(60_000 - 50);
      // The service captures `now` after the test's timestamp; allow the
      // sub-millisecond scheduling gap without weakening the jitter contract.
      expect(delay).toBeLessThanOrEqual(60_100);
    });
  });

  describe('classifyFailure hook (Messenger)', () => {
    it('uses the hook classification and error message', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('24h window'));
      options.classifyFailure.mockReturnValue({
        terminal: true,
        errorMessage: 'Messenger 24h messaging window closed',
      });
      build();

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: true,
          errorMessage: 'Messenger 24h messaging window closed',
          retryCount: 3,
        }),
      );
      expect(result).toMatchObject({ failed: 1, retried: 0 });
      expect(result.failures[0]).toEqual({
        jobId: 1,
        externalUserId: 'ext-1',
        error: 'Messenger 24h messaging window closed',
      });
    });

    it('falls back to default classification when the hook returns undefined', async () => {
      const job = makeJob({ retryCount: 3, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendText.mockRejectedValue(new Error('Persistent'));
      build();

      await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: true, retryCount: 4 }),
      );
    });
  });

  it('aggregates failures across multiple jobs', async () => {
    const job1 = makeJob({ id: 1 });
    const job2 = makeJob({ id: 2 });
    jobRepo.findDueJobs.mockResolvedValue([job1, job2]);
    jobRepo.claimJob.mockImplementation((id) =>
      Promise.resolve(id === 1 ? job1 : job2),
    );
    messageSender.sendText.mockRejectedValue(new Error('Send fail'));
    build();

    const result = await service.dispatchDueReminders();

    expect(result.failures).toHaveLength(2);
    expect(result.retried).toBe(2);
  });

  it('returns null nextDueAt when the repository throws', async () => {
    jobRepo.findNextDueTime.mockRejectedValue(new Error('DB error'));
    build();

    const result = await service.dispatchDueReminders();

    expect(result.nextDueAt).toBeNull();
  });

  describe('slow-send lease regression (#113)', () => {
    it('does not double-send while the first worker lease is live', async () => {
      let resolveSlowSend!: () => void;
      const slowSendGate = new Promise<void>((resolve) => {
        resolveSlowSend = resolve;
      });
      let sendCalls = 0;
      const slowJob = {
        ...makeJob({ id: 1 }),
        leaseToken: 'lease-a',
      };

      // First dispatch sees the job; while it is being sent the job is
      // 'processing', so later dispatches never even see it as due.
      jobRepo.findDueJobs
        .mockResolvedValueOnce([slowJob])
        .mockResolvedValue([]);
      jobRepo.claimJob.mockResolvedValue(slowJob);
      jobRepo.resetStuckProcessingJobs.mockResolvedValue(0);
      messageSender.sendText.mockImplementation(async () => {
        sendCalls += 1;
        await slowSendGate;
        return 'sent';
      });
      build();

      const first = service.dispatchDueReminders();
      // Second dispatch while the first send is still in flight: the lease is
      // live (resetStuck=0) and the job is 'processing' (not due) — it must
      // NOT be claimed or sent again.
      await service.dispatchDueReminders();
      resolveSlowSend();
      await first;

      expect(sendCalls).toBe(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.claimJob).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markSent).toHaveBeenCalledWith(
        1,
        'lease-a',
        'sent',
        expect.stringMatching(/^reminder:1:/),
      );
    });

    it('reopens an expired lease as ambiguous and never blind-resends', async () => {
      let resolveSlowSend!: () => void;
      const slowSendGate = new Promise<void>((resolve) => {
        resolveSlowSend = resolve;
      });
      let sendCalls = 0;
      const firstClaim = { ...makeJob({ id: 1 }), leaseToken: 'lease-a' };
      const secondClaim = {
        ...makeJob({ id: 1, deliveryStatus: 'ambiguous' }),
        leaseToken: 'lease-b',
      };

      jobRepo.resetStuckProcessingJobs.mockResolvedValue(0);
      jobRepo.findDueJobs
        .mockResolvedValueOnce([firstClaim]) // first dispatch picks it up
        .mockResolvedValueOnce([secondClaim]); // second dispatch: reopened
      jobRepo.claimJob
        .mockResolvedValueOnce(firstClaim)
        .mockResolvedValueOnce(secondClaim);
      messageSender.sendText.mockImplementation(async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          await slowSendGate;
        }
        return 'sent';
      });
      build();

      const first = service.dispatchDueReminders();
      // First worker still sending; its lease expired → recovery reopens the
      // job, the new worker claims with a fresh token and sends once.
      await service.dispatchDueReminders();
      resolveSlowSend();
      await first;

      // The first worker may have sent before its lease expired; the reclaimed
      // ambiguous row must never issue a second provider call.
      expect(sendCalls).toBe(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markSent).toHaveBeenCalledWith(
        1,
        'lease-a',
        'sent',
        expect.stringMatching(/^reminder:1:/),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markSent).toHaveBeenCalledTimes(1);
    });

    describe('dormancy gate', () => {
      it('cancels dormant recipient job with exact reason and triggers hook', async () => {
        const job = makeJob({ id: 1, userId: 101, externalUserId: 'u101' });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue({
          ...job,
          leaseToken: 'lease-token-1',
        });

        const filterDormantUserIds = jest.fn().mockResolvedValue([101]);
        options.filterDormantUserIds = filterDormantUserIds;
        hooks.onCancelled = jest.fn();

        build();

        const result = await service.dispatchDueReminders();

        expect(filterDormantUserIds).toHaveBeenCalledWith([101]);
        expect(jobRepo.markCancelled).toHaveBeenCalledWith(
          1,
          'lease-token-1',
          'recipient dormant (web inactivity)',
        );
        expect(result.cancelled).toBe(1);
        expect(messageSender.sendText).not.toHaveBeenCalled();
        expect(hooks.onCancelled).toHaveBeenCalledWith({
          jobId: 1,
          externalUserId: 'u101',
          reason: 'recipient dormant (web inactivity)',
        });
      });

      it('sends to active recipient in same batch when only one is dormant', async () => {
        const job1 = makeJob({ id: 1, userId: 101, externalUserId: 'u101' });
        const job2 = makeJob({ id: 2, userId: 102, externalUserId: 'u102' });
        jobRepo.findDueJobs.mockResolvedValue([job1, job2]);
        jobRepo.claimJob
          .mockResolvedValueOnce({ ...job1, leaseToken: 'lease-1' })
          .mockResolvedValueOnce({ ...job2, leaseToken: 'lease-2' });

        options.filterDormantUserIds = jest.fn().mockResolvedValue([101]);
        build();

        const result = await service.dispatchDueReminders();

        expect(result.cancelled).toBe(1);
        expect(result.sent).toBe(1);
        expect(jobRepo.markCancelled).toHaveBeenCalledWith(
          1,
          'lease-1',
          'recipient dormant (web inactivity)',
        );
        expect(jobRepo.markSent).toHaveBeenCalledWith(
          2,
          'lease-2',
          expect.any(String),
          expect.any(String),
        );
      });

      it('does not pass userId == null to filterDormantUserIds and proceeds', async () => {
        const job = makeJob({
          id: 1,
          userId: undefined,
          externalUserId: 'u-anon',
        });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue({
          ...job,
          leaseToken: 'lease-anon',
        });

        const filterDormantUserIds = jest.fn().mockResolvedValue([]);
        options.filterDormantUserIds = filterDormantUserIds;
        build();

        const result = await service.dispatchDueReminders();

        expect(filterDormantUserIds).not.toHaveBeenCalled();
        expect(result.sent).toBe(1);
      });

      it('fails open when filterDormantUserIds throws', async () => {
        const job = makeJob({ id: 1, userId: 101, externalUserId: 'u101' });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue({ ...job, leaseToken: 'lease-1' });

        options.filterDormantUserIds = jest
          .fn()
          .mockRejectedValue(new Error('db timeout'));
        build();

        const result = await service.dispatchDueReminders();

        expect(result.cancelled).toBe(0);
        expect(result.sent).toBe(1);
      });

      it('never calls filterDormantUserIds when option is absent', async () => {
        const job = makeJob({ id: 1, userId: 101, externalUserId: 'u101' });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue({ job, leaseToken: 'lease-1' });

        build();

        const result = await service.dispatchDueReminders();

        expect(result.sent).toBe(1);
      });
    });
  });
});
