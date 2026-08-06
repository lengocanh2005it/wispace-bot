import { MessengerAgentToolsService } from './messenger-agent-tools.service';
import type { MessengerAgentToolContext } from './messenger-agent-tools.service';
import type { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';
import type { StudyDataPort } from '../../domain/ports/study-data.port';
import type { MessengerRescheduleConfirmationService } from '../services/messenger-reschedule-confirmation.service';
import type { UserGoalsApiService } from '../../../student-report/infrastructure/wispace/user-goals-api.service';
import type { StudentReportService } from '../../../student-report/application/services/student-report.service';

describe('MessengerAgentToolsService', () => {
  const createService = (
    overrides: Partial<Record<string, jest.Mock>> = {},
  ) => {
    const repository: jest.Mocked<MessengerRepositoryPort> = {
      logMessage: jest.fn(),
      findActiveMappingByPsid: overrides.findActiveMappingByPsid ?? jest.fn(),
      upsertPocSubscription: overrides.upsertPocSubscription ?? jest.fn(),
    } as unknown as jest.Mocked<MessengerRepositoryPort>;

    const studentReportService: jest.Mocked<StudentReportService> = {
      generateReport: overrides.generateReport ?? jest.fn(),
    } as unknown as jest.Mocked<StudentReportService>;

    const userGoalsApiService: jest.Mocked<UserGoalsApiService> = {
      getUserGoals: overrides.getUserGoals ?? jest.fn(),
    } as unknown as jest.Mocked<UserGoalsApiService>;

    const studyPort: jest.Mocked<StudyDataPort> = {
      getUpcomingSessions: overrides.getUpcomingSessions ?? jest.fn(),
      getNextUpcomingSession: overrides.getNextUpcomingSession ?? jest.fn(),
      generateReminderBundleForSession:
        overrides.generateReminderBundleForSession ?? jest.fn(),
      listCalendarEntries: overrides.listEntries ?? jest.fn(),
      getOutboxSettings: jest.fn(() => ({ minutesBefore: 30 })),
      formatScheduledTimeLabel: jest.fn(() => 'Thứ 2, 08:00'),
    } as unknown as jest.Mocked<StudyDataPort>;

    const rescheduleConfirmationService: jest.Mocked<MessengerRescheduleConfirmationService> =
      {
        stage: overrides.stage ?? jest.fn(),
      } as unknown as jest.Mocked<MessengerRescheduleConfirmationService>;

    const service = new MessengerAgentToolsService(
      repository,
      studentReportService,
      userGoalsApiService,
      studyPort,
      rescheduleConfirmationService,
    );

    const ctx: MessengerAgentToolContext = {
      psid: 'psid-123',
      userId: 42,
      richFollowUps: [],
    };

    return {
      service,
      ctx,
      repository,
      studentReportService,
      userGoalsApiService,
      studyPort,
      rescheduleConfirmationService,
    };
  };

  describe('execute', () => {
    it('returns error for unknown tool', async () => {
      const { service, ctx } = createService();
      const result = await service.execute('unknown_tool', '{}', ctx);
      expect(result).toEqual({ error: 'Unknown tool: unknown_tool' });
    });

    it('returns error for invalid JSON', async () => {
      const { service, ctx } = createService();
      const result = await service.execute(
        'get_learning_progress_report',
        'invalid',
        ctx,
      );
      expect(result).toEqual({ error: 'Invalid tool arguments JSON' });
    });

    it('handles tool execution error', async () => {
      const { service, ctx } = createService({
        generateReport: jest.fn().mockRejectedValue(new Error('API error')),
      });
      const result = await service.execute(
        'get_learning_progress_report',
        '{}',
        ctx,
      );
      expect(result).toEqual({ error: 'API error' });
    });
  });

  describe('get_learning_progress_report', () => {
    it('calls studentReportService.generateReport', async () => {
      const report = { text: 'Report content', scores: [] };
      const { service, ctx } = createService({
        generateReport: jest.fn().mockResolvedValue(report),
      });

      const result = await service.execute(
        'get_learning_progress_report',
        '{}',
        ctx,
      );

      expect(result).toEqual({ report });
    });
  });

  describe('get_user_goals', () => {
    it('calls userGoalsApiService.getUserGoals', async () => {
      const goals = { goals: [{ id: 1, name: 'IELTS 7.0' }] };
      const { service, ctx } = createService({
        getUserGoals: jest.fn().mockResolvedValue(goals),
      });

      const result = await service.execute('get_user_goals', '{}', ctx);

      expect(result).toEqual(goals);
    });
  });

  describe('get_upcoming_study_sessions', () => {
    it('returns sessions with time labels', async () => {
      const sessions = [
        {
          sessionKey: 'key-1',
          topic: 'IELTS Writing',
          scheduledAt: new Date('2026-07-15T08:00:00Z'),
        },
      ];
      const { service, ctx } = createService({
        getUpcomingSessions: jest.fn().mockResolvedValue(sessions),
      });

      const result = await service.execute(
        'get_upcoming_study_sessions',
        '{"limit": 5}',
        ctx,
      );

      expect(result).toMatchObject({
        count: 1,
        sessions: [
          expect.objectContaining({
            sessionKey: 'key-1',
            topic: 'IELTS Writing',
          }),
        ],
      });
    });

    it('returns empty when no sessions', async () => {
      const { service, ctx } = createService({
        getUpcomingSessions: jest.fn().mockResolvedValue([]),
      });

      const result = await service.execute(
        'get_upcoming_study_sessions',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        count: 0,
        sessions: [],
        reminderNotice: undefined,
      });
    });
  });

  describe('list_study_calendar_entries', () => {
    it('returns calendar entries with reminder notice', async () => {
      const entries = [
        {
          calendarId: 1,
          scheduledTimeLabel: 'Thứ 3, 09:00',
        },
      ];
      const { service, ctx } = createService({
        listEntries: jest.fn().mockResolvedValue({
          entries,
          timeRange: 'upcoming',
          total: 1,
        }),
      });

      const result = await service.execute(
        'list_study_calendar_entries',
        '{"timeRange": "upcoming"}',
        ctx,
      );

      expect(result).toMatchObject({
        entries,
        timeRange: 'upcoming',
        reminderNotice: expect.any(String), // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      });
    });
  });

  describe('reschedule_study_session', () => {
    it('returns error when no userId', async () => {
      const { service } = createService();
      const ctx = { psid: 'psid-123', richFollowUps: [] };

      const result = await service.execute(
        'reschedule_study_session',
        '{"calendarId": 1, "schedulingMode": "default_next_day_same_time"}',
        ctx,
      );

      expect(result).toMatchObject({
        rescheduled: false,
        message: expect.stringContaining('Chưa liên kết'), // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      });
    });

    it('returns error when calendarId not found', async () => {
      const { service, ctx } = createService({
        listEntries: jest.fn().mockResolvedValue({ entries: [], total: 0 }),
      });

      const result = await service.execute(
        'reschedule_study_session',
        '{"calendarId": 999, "schedulingMode": "default_next_day_same_time"}',
        ctx,
      );

      expect(result).toMatchObject({
        error: expect.stringContaining('calendarId 999 không có'), // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      });
    });

    it('stages reschedule when valid', async () => {
      const { service, ctx } = createService({
        listEntries: jest.fn().mockResolvedValue({
          entries: [{ calendarId: 1, scheduledTimeLabel: 'Thứ 2, 08:00' }],
          total: 1,
        }),
        stage: jest.fn().mockResolvedValue({
          sessionLabel: 'IELTS Writing',
          summary: 'Đổi lịch từ Thứ 2 sang Thứ 3',
          richFollowUp: { type: 'button', title: 'Xác nhận' },
        }),
      });

      const result = await service.execute(
        'reschedule_study_session',
        '{"calendarId": 1, "schedulingMode": "default_next_day_same_time"}',
        ctx,
      );

      expect(result).toMatchObject({
        pendingConfirmation: true,
        sessionLabel: 'IELTS Writing',
      });
      expect(ctx.richFollowUps).toHaveLength(1);
    });
  });

  describe('preview_next_study_reminder', () => {
    it('returns no session message when none', async () => {
      const { service, ctx } = createService({
        getNextUpcomingSession: jest.fn().mockResolvedValue(null),
      });

      const result = await service.execute(
        'preview_next_study_reminder',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        hasSession: false,
        message: expect.any(String), // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      });
    });

    it('returns reminder bundle when session exists', async () => {
      const session = {
        sessionKey: 'key-1',
        scheduledAt: new Date('2026-07-15T08:00:00Z'),
      };
      const { service, ctx } = createService({
        getNextUpcomingSession: jest.fn().mockResolvedValue(session),
        generateReminderBundleForSession: jest.fn().mockResolvedValue({
          text: 'Reminder text',
          output: { greeting: 'Chào bạn', intro: 'Buổi học sắp bắt đầu' },
        }),
      });

      const result = await service.execute(
        'preview_next_study_reminder',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        hasSession: true,
        scheduledTimeLabel: 'Thứ 2, 08:00',
        reminder: 'Reminder text',
      });
      expect(ctx.richFollowUps).toHaveLength(1);
    });
  });

  describe('register_exam_report_notifications', () => {
    it('returns not registered when no link context', async () => {
      const { service, ctx } = createService({
        findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
      });

      const result = await service.execute(
        'register_exam_report_notifications',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        registered: false,
        message: expect.stringContaining('Chưa liên kết'), // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      });
    });

    it('returns already active when same cadence and topic', async () => {
      const { service, ctx } = createService({
        findActiveMappingByPsid: jest.fn().mockResolvedValue({
          userId: 42,
          cadence: 'daily',
          topic: 'exam',
        }),
      });
      ctx.linkContext = {
        userId: 42,
        cadence: 'daily',
        topic: 'exam',
      };

      const result = await service.execute(
        'register_exam_report_notifications',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        registered: true,
        alreadyActive: true,
      });
    });

    it('upserts subscription when new or different', async () => {
      const { service, ctx } = createService({
        findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
      });
      ctx.linkContext = {
        userId: 42,
        cadence: 'daily',
        topic: 'exam',
      };

      const result = await service.execute(
        'register_exam_report_notifications',
        '{}',
        ctx,
      );

      expect(result).toMatchObject({
        registered: true,
        alreadyActive: false,
      });
    });
  });

  describe('tryFastDefaultReschedule', () => {
    it('returns null when no userId', async () => {
      const { service } = createService();
      const ctx = { psid: 'psid-123', richFollowUps: [] };

      const result = await service.tryFastDefaultReschedule(
        ctx,
        'đổi lịch giúp mình',
      );

      expect(result).toBeNull();
    });

    it('returns null when multiple entries', async () => {
      const { service, ctx } = createService({
        listEntries: jest.fn().mockResolvedValue({
          entries: [
            { calendarId: 1, scheduledTimeLabel: 'Thứ 2' },
            { calendarId: 2, scheduledTimeLabel: 'Thứ 3' },
          ],
        }),
      });

      const result = await service.tryFastDefaultReschedule(
        ctx,
        'đổi lịch giúp mình',
      );

      expect(result).toBeNull();
    });
  });
});
