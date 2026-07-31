import { MessengerApiError } from '@messenger/modules/messenger/application/services/messenger-outbound.service';
import { shouldSkipProactiveRetries } from '@messenger/modules/messenger/application/utils/proactive-send.utils';
import { WispaceApiError } from '@messenger/shared/errors/wispace-api.error';
import type { StudyReminderJobRepositoryPort } from '../../domain/repositories/study-reminder-job.repository.port';
import type { MessageSenderPort } from '@messenger/modules/messenger/application/ports/message-sender.port';
import type { StudyReminderJob } from '../../domain/entities/study-reminder-job.types';
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudyReminderService } from './study-reminder.service';

describe('StudyReminderDispatchService', () => {
  it('treats Messenger 24h window as terminal failure without retry (L2)', () => {
    const error = new MessengerApiError(
      'Send failed',
      400,
      'Bad Request',
      '{"error":{"code":10}}',
    );

    expect(shouldSkipProactiveRetries(error)).toBe(true);
  });

  describe('dispatchDueReminders', () => {
    let service: StudyReminderDispatchService;
    let jobRepo: jest.Mocked<StudyReminderJobRepositoryPort>;
    let scheduleService: jest.Mocked<
      Pick<
        StudyReminderScheduleService,
        'getOutboxSettings' | 'isSessionStarted'
      >
    >;
    let reminderService: jest.Mocked<
      Pick<
        StudyReminderService,
        'preloadDisplayNames' | 'generateReminderForSession'
      >
    >;
    let messageSender: jest.Mocked<MessageSenderPort>;
    let metrics: { incReminderDispatch: jest.Mock };

    const defaultSettings = {
      stuckProcessingMs: 600_000,
      minLeadMinutes: 1,
      retryBackoffMinutes: 2,
    };

    function makeJob(
      overrides: Partial<StudyReminderJob> = {},
    ): StudyReminderJob {
      return {
        id: 1,
        platform: 'messenger',
        psid: 'psid-1',
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
        markSent: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        findNextDueTime: jest.fn().mockResolvedValue(null),
        upsertPendingJob: jest.fn(),
        cancelStaleJobsForPsid: jest.fn(),
        cancelJobsFromOtherPlatforms: jest.fn(),
      };

      scheduleService = {
        getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
        isSessionStarted: jest.fn().mockReturnValue(false),
      };

      reminderService = {
        preloadDisplayNames: jest.fn().mockResolvedValue(undefined),
        generateReminderForSession: jest
          .fn()
          .mockResolvedValue('Nhắc nhở học toán!'),
      };

      messageSender = {
        sendTextViaPsid: jest.fn().mockResolvedValue(undefined),
      };

      metrics = { incReminderDispatch: jest.fn() };

      service = new StudyReminderDispatchService(
        jobRepo,
        scheduleService as unknown as StudyReminderScheduleService,
        reminderService as unknown as StudyReminderService,
        messageSender,
        metrics,
      );
    });

    it('returns zero counts when no due jobs exist', async () => {
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

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(messageSender.sendTextViaPsid).toHaveBeenCalledWith(
        expect.objectContaining({ psid: 'psid-1', text: 'Nhắc nhở học toán!' }),
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markSent).toHaveBeenCalledWith(1);
      expect(result).toMatchObject({
        claimed: 1,
        sent: 1,
        cancelled: 0,
        failed: 0,
      });
    });

    it('cancels job when session has already started', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      (scheduleService.isSessionStarted as jest.Mock).mockReturnValue(true);

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markCancelled).toHaveBeenCalledWith(
        1,
        'session already started',
      );
      expect(result).toMatchObject({ claimed: 1, cancelled: 1, sent: 0 });
    });

    it('skips unclaimed jobs — another pod claimed first', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(null);

      const result = await service.dispatchDueReminders();

      expect(result.claimed).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markSent).not.toHaveBeenCalled();
    });

    it('marks job terminal on Messenger 24h window error', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendTextViaPsid.mockRejectedValue(
        new MessengerApiError(
          'Send failed',
          400,
          'Bad Request',
          '{"error":{"code":10}}',
        ),
      );

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 1, terminal: true }),
      );
      expect(result).toMatchObject({ failed: 1, retried: 0 });
      expect(result.failures[0]?.error).toContain('24h');
    });

    it('marks terminal on non-retryable Wispace error', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      reminderService.generateReminderForSession.mockRejectedValue(
        new WispaceApiError('Not Found', 404, 'psid-1', 'UserCalendar'),
      );

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: true }),
      );
      expect(result.failed).toBe(1);
    });

    it('schedules retry when error is transient and retries remain', async () => {
      const job = makeJob({ retryCount: 0, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      reminderService.generateReminderForSession.mockRejectedValue(
        new Error('Transient network error'),
      );

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: false,
          retryCount: 1,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          nextRetryAt: expect.any(Date),
        }),
      );
      expect(result).toMatchObject({ retried: 1, failed: 0 });
    });

    it('marks terminal when maxRetries is reached', async () => {
      const job = makeJob({ retryCount: 3, maxRetries: 3 });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      messageSender.sendTextViaPsid.mockRejectedValue(
        new Error('Persistent error'),
      );

      const result = await service.dispatchDueReminders();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(jobRepo.markFailed).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: true, retryCount: 4 }),
      );
      expect(result.failed).toBe(1);
    });

    it('preloads display names in one batch for all jobs with userId', async () => {
      const jobs = [
        makeJob({ id: 1, userId: 10 }),
        makeJob({ id: 2, userId: 20 }),
      ];
      jobRepo.findDueJobs.mockResolvedValue(jobs);
      jobRepo.claimJob.mockResolvedValue(null);

      await service.dispatchDueReminders();

      expect(reminderService.preloadDisplayNames).toHaveBeenCalledWith([
        10, 20,
      ]);
    });

    it('deduplicates userIds when preloading display names', async () => {
      const jobs = [
        makeJob({ id: 1, userId: 42 }),
        makeJob({ id: 2, userId: 42 }),
      ];
      jobRepo.findDueJobs.mockResolvedValue(jobs);
      jobRepo.claimJob.mockResolvedValue(null);

      await service.dispatchDueReminders();

      expect(reminderService.preloadDisplayNames).toHaveBeenCalledWith([42]);
    });

    it('continues dispatching when preloadDisplayNames fails', async () => {
      const job = makeJob();
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(job);
      reminderService.preloadDisplayNames.mockRejectedValue(
        new Error('Redis down'),
      );

      const result = await service.dispatchDueReminders();

      expect(result.sent).toBe(1);
    });

    it('skips jobs without userId when preloading', async () => {
      const job = makeJob({ userId: undefined });
      jobRepo.findDueJobs.mockResolvedValue([job]);
      jobRepo.claimJob.mockResolvedValue(null);

      await service.dispatchDueReminders();

      expect(reminderService.preloadDisplayNames).not.toHaveBeenCalled();
    });

    it('aggregates failures across multiple jobs', async () => {
      const job1 = makeJob({ id: 1 });
      const job2 = makeJob({ id: 2 });
      jobRepo.findDueJobs.mockResolvedValue([job1, job2]);
      jobRepo.claimJob.mockImplementation((id) =>
        Promise.resolve(id === 1 ? job1 : job2),
      );
      messageSender.sendTextViaPsid.mockRejectedValue(new Error('Send fail'));

      const result = await service.dispatchDueReminders();

      expect(result.failures).toHaveLength(2);
      expect(result.retried).toBe(2);
    });

    it('returns nextDueAt from repository', async () => {
      const nextDue = new Date('2026-06-27T12:00:00Z');
      jobRepo.findNextDueTime.mockResolvedValue(nextDue);

      const result = await service.dispatchDueReminders();

      expect(result.nextDueAt).toEqual(nextDue);
    });

    it('returns null nextDueAt when repository throws', async () => {
      jobRepo.findNextDueTime.mockRejectedValue(new Error('DB error'));

      const result = await service.dispatchDueReminders();

      expect(result.nextDueAt).toBeNull();
    });

    describe('metrics — reminderDispatch counter', () => {
      it('increments status=sent on successful dispatch', async () => {
        const job = makeJob();
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue(job);

        await service.dispatchDueReminders();

        expect(metrics.incReminderDispatch).toHaveBeenCalledWith('sent');
        expect(metrics.incReminderDispatch).toHaveBeenCalledTimes(1);
      });

      it('increments status=cancelled when session already started', async () => {
        const job = makeJob();
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue(job);
        (scheduleService.isSessionStarted as jest.Mock).mockReturnValue(true);

        await service.dispatchDueReminders();

        expect(metrics.incReminderDispatch).toHaveBeenCalledWith('cancelled');
      });

      it('increments status=failed on terminal error', async () => {
        const job = makeJob({ retryCount: 3, maxRetries: 3 });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue(job);
        messageSender.sendTextViaPsid.mockRejectedValue(
          new Error('Persistent error'),
        );

        await service.dispatchDueReminders();

        expect(metrics.incReminderDispatch).toHaveBeenCalledWith('failed');
      });

      it('increments status=retried on transient error with retries remaining', async () => {
        const job = makeJob({ retryCount: 0, maxRetries: 3 });
        jobRepo.findDueJobs.mockResolvedValue([job]);
        jobRepo.claimJob.mockResolvedValue(job);
        reminderService.generateReminderForSession.mockRejectedValue(
          new Error('Transient error'),
        );

        await service.dispatchDueReminders();

        expect(metrics.incReminderDispatch).toHaveBeenCalledWith('retried');
      });

      it('does not increment when no jobs are claimed', async () => {
        jobRepo.findDueJobs.mockResolvedValue([makeJob()]);
        jobRepo.claimJob.mockResolvedValue(null);

        await service.dispatchDueReminders();

        expect(metrics.incReminderDispatch).not.toHaveBeenCalled();
      });
    });
  });
});
