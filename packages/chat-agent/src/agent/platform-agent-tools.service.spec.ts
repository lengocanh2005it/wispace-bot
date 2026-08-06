import { AGENT_TOOL_NAMES } from '@wispace/llm-agent';
import type {
  WispaceCalendarService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { PlatformAgentToolsService } from './platform-agent-tools.service';
import type {
  PlatformAgentToolContext,
  PlatformAgentToolsOptions,
} from './platform-agent.types';

const DISCORD_NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Discord. Vào WISPACE để lấy link "Kết nối Discord" rồi thử lại nhé.';

const DISCORD_REGISTER_MESSAGE =
  'Bạn đã đăng ký nhận báo cáo học tập. WISPACE sẽ gửi báo cáo AI qua Discord vào mỗi buổi sáng — khoảng 2–3 ngày trước ngày thi bạn sẽ nhận được báo cáo chi tiết.';

const ZALO_NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Liên kết tài khoản để sử dụng tính năng này nhé.';

const ZALO_REGISTER_MESSAGE =
  'Bạn đã được đăng ký nhận báo cáo học tập qua Zalo mỗi sáng lúc 08:00 (không cần đăng ký riêng).';

function buildDiscordOptions(
  confirmSender: (externalUserId: string, summary: string) => Promise<void>,
): PlatformAgentToolsOptions {
  return {
    getNotLinkedMessage: () => DISCORD_NOT_LINKED_MESSAGE,
    wispaceExternalId: (ctx) => ctx.externalUserId,
    registerReportMessage: DISCORD_REGISTER_MESSAGE,
    reschedule: {
      validateDateAndTime: true,
      messages: {
        calendarIdRequired: 'calendarId is required',
        schedulingModeInvalid:
          'schedulingMode must be default_next_day_same_time or explicit',
        newLocalDateInvalid: 'newLocalDate must be in YYYY-MM-DD format',
        newTimeInvalid: 'newTime must be in HH:MM format',
      },
      confirmSender,
    },
  };
}

function buildZaloOptions(
  confirmSender: (externalUserId: string, summary: string) => Promise<void>,
): PlatformAgentToolsOptions {
  const appId = 'app-1';
  const redirectUri = 'https://zalo-bot.example.com/zalo/oauth/callback';
  const oauthAuthorizeUrl =
    appId && redirectUri
      ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
      : '';
  return {
    getNotLinkedMessage: () => {
      const linkPart = oauthAuthorizeUrl
        ? `\n\nLiên kết tài khoản tại đây: ${oauthAuthorizeUrl}`
        : '';
      return `${ZALO_NOT_LINKED_MESSAGE}${linkPart}`;
    },
    wispaceExternalId: (ctx) => String(ctx.userId),
    registerReportMessage: ZALO_REGISTER_MESSAGE,
    reschedule: {
      validateDateAndTime: false,
      messages: {
        calendarIdRequired: 'calendarId (số nguyên dương) là bắt buộc.',
        schedulingModeInvalid:
          'schedulingMode (default_next_day_same_time hoặc explicit) là bắt buộc.',
        newLocalDateInvalid: '',
        newTimeInvalid: '',
      },
      confirmSender,
    },
  };
}

function buildGoalsService(): WispaceGoalsService {
  return {
    getUserGoals: () =>
      Promise.resolve({
        targetBand: '7.0',
        examDate: '2025-03-01',
        task1Band: '6.5',
        task2Band: '7.0',
      }),
    getTaskScoreAverages: () =>
      Promise.resolve([{ task1Count: 10, task2Count: 15 }]),
  } as unknown as WispaceGoalsService;
}

function buildCalendarService(): WispaceCalendarService {
  return {
    getCalendarSessions: () => Promise.resolve([]),
  } as unknown as WispaceCalendarService;
}

describe('PlatformAgentToolsService', () => {
  let goalsService: jest.Mocked<
    Pick<WispaceGoalsService, 'getUserGoals' | 'getTaskScoreAverages'>
  >;
  let calendarService: jest.Mocked<
    Pick<WispaceCalendarService, 'getCalendarSessions'>
  >;
  let stagePort: { stage: jest.Mock };
  let confirmSender: jest.Mock;
  let service: PlatformAgentToolsService;

  beforeEach(() => {
    goalsService = {
      getUserGoals: jest.fn(),
      getTaskScoreAverages: jest.fn(),
    };
    calendarService = {
      getCalendarSessions: jest.fn(),
    };
    stagePort = { stage: jest.fn() };
    confirmSender = jest.fn().mockResolvedValue(undefined);
  });

  describe('discord behavior', () => {
    beforeEach(() => {
      service = new PlatformAgentToolsService(
        goalsService as unknown as WispaceGoalsService,
        calendarService as unknown as WispaceCalendarService,
        stagePort,
        buildDiscordOptions(confirmSender),
      );
    });

    it('returns an error for an unknown tool name', async () => {
      const result = await service.execute('not_a_real_tool', '{}', {
        externalUserId: 'discord-1',
      });

      expect(result).toEqual({ error: 'Unknown tool: not_a_real_tool' });
    });

    it('returns available=false for every WISPACE tool when the account is unlinked', async () => {
      for (const toolName of AGENT_TOOL_NAMES) {
        const result = await service.execute(toolName, '{}', {
          externalUserId: 'discord-1',
        });

        expect(result).toMatchObject({ available: false });
      }
    });

    it('get_user_goals calls WispaceGoalsService with the externalUserId when linked', async () => {
      goalsService.getUserGoals.mockResolvedValue({
        targetScore: 7,
        examDate: '2026-08-01',
      });

      const result = await service.execute('get_user_goals', '{}', {
        externalUserId: 'discord-1',
        userId: 143,
      });

      expect(goalsService.getUserGoals).toHaveBeenCalledWith('discord-1');
      expect(result).toEqual({ targetScore: 7, examDate: '2026-08-01' });
    });

    it('marks the tool context as private-data-fetched', async () => {
      goalsService.getUserGoals.mockResolvedValue({});

      const ctx: PlatformAgentToolContext = {
        externalUserId: 'discord-1',
        userId: 143,
        privateDataFetched: false,
      };
      await service.execute('get_user_goals', '{}', ctx);

      expect(ctx.privateDataFetched).toBe(true);
    });

    it('get_learning_progress_report combines goals and task scores when linked', async () => {
      goalsService.getUserGoals.mockResolvedValue({
        targetScore: 7,
        examDate: '2026-08-01',
      });
      goalsService.getTaskScoreAverages.mockResolvedValue([]);

      const result = await service.execute(
        'get_learning_progress_report',
        '{}',
        { externalUserId: 'discord-1', userId: 143 },
      );

      expect(result).toContain('Báo cáo tiến độ');
      expect(result).toContain('2026-08-01');
    });

    it('get_upcoming_study_sessions maps calendar sessions when linked', async () => {
      calendarService.getCalendarSessions.mockResolvedValue([
        {
          sessionKey: 'calendar:1',
          scheduledAt: new Date('2026-08-01T07:00:00Z'),
          topic: 'IELTS Writing',
        },
      ]);

      const result = await service.execute(
        'get_upcoming_study_sessions',
        '{}',
        {
          externalUserId: 'discord-1',
          userId: 143,
        },
      );

      expect(calendarService.getCalendarSessions).toHaveBeenCalledWith(
        'discord-1',
        { timeRange: 'upcoming', limit: 5 },
      );
      expect(result).toEqual({
        count: 1,
        sessions: [
          {
            sessionKey: 'calendar:1',
            topic: 'IELTS Writing',
            scheduledAtIso: '2026-08-01T07:00:00.000Z',
          },
        ],
      });
    });

    it('list_study_calendar_entries passes timeRange/limit/pastDays through when linked', async () => {
      calendarService.getCalendarSessions.mockResolvedValue([]);

      await service.execute(
        'list_study_calendar_entries',
        JSON.stringify({ timeRange: 'past', limit: 3, pastDays: 30 }),
        { externalUserId: 'discord-1', userId: 143 },
      );

      expect(calendarService.getCalendarSessions).toHaveBeenCalledWith(
        'discord-1',
        { timeRange: 'past', limit: 3, pastDays: 30 },
      );
    });

    it('preview_next_study_reminder reports hasSession=false when no sessions', async () => {
      calendarService.getCalendarSessions.mockResolvedValue([]);

      const result = await service.execute(
        'preview_next_study_reminder',
        '{}',
        {
          externalUserId: 'discord-1',
          userId: 143,
        },
      );

      expect(result).toEqual({ hasSession: false });
    });

    it('register_exam_report_notifications returns success when linked', async () => {
      const result = await service.execute(
        'register_exam_report_notifications',
        '{}',
        { externalUserId: 'discord-1', userId: 143 },
      );

      expect(result).toMatchObject({ registered: true });
    });

    it('register_exam_report_notifications returns not-linked message when unlinked', async () => {
      const result = await service.execute(
        'register_exam_report_notifications',
        '{}',
        { externalUserId: 'discord-1' },
      );

      expect(result).toMatchObject({ available: false });
    });

    describe('reschedule_study_session (discord validation)', () => {
      it('errors when calendarId is missing', async () => {
        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({ schedulingMode: 'default_next_day_same_time' }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(result).toEqual({ error: 'calendarId is required' });
        expect(stagePort.stage).not.toHaveBeenCalled();
      });

      it('errors when schedulingMode is invalid', async () => {
        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({ calendarId: 1, schedulingMode: 'bogus' }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(result).toMatchObject({ error: expect.any(String) as string });
        expect(stagePort.stage).not.toHaveBeenCalled();
      });

      it('errors when newLocalDate is malformed', async () => {
        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({
            calendarId: 42,
            schedulingMode: 'explicit',
            newLocalDate: 'not-a-date',
          }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(result).toEqual({
          error: 'newLocalDate must be in YYYY-MM-DD format',
        });
      });

      it('errors when newTime is malformed', async () => {
        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({
            calendarId: 42,
            schedulingMode: 'explicit',
            newTime: '9am',
          }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(result).toEqual({ error: 'newTime must be in HH:MM format' });
      });

      it('stages the reschedule and sends the confirmation when valid', async () => {
        stagePort.stage.mockResolvedValue({
          pendingConfirmation: true,
          sessionLabel: 'Ngày mai lúc 19:00',
          summary: 'Dời buổi Ngày mai lúc 19:00 sang ngày kế tiếp cùng giờ?',
        });

        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({
            calendarId: 42,
            schedulingMode: 'default_next_day_same_time',
          }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(stagePort.stage).toHaveBeenCalledWith({
          externalId: 'discord-1',
          userId: 143,
          calendarId: 42,
          schedulingMode: 'default_next_day_same_time',
          newLocalDate: undefined,
          newTime: undefined,
        });
        expect(confirmSender).toHaveBeenCalledWith(
          'discord-1',
          'Dời buổi Ngày mai lúc 19:00 sang ngày kế tiếp cùng giờ?',
        );
        expect(result).toEqual({
          pendingConfirmation: true,
          sessionLabel: 'Ngày mai lúc 19:00',
        });
      });

      it('returns the staging error without sending a confirmation', async () => {
        stagePort.stage.mockResolvedValue({
          error: 'calendarId 42 không có trong lịch sắp tới.',
        });

        const result = await service.execute(
          'reschedule_study_session',
          JSON.stringify({
            calendarId: 42,
            schedulingMode: 'default_next_day_same_time',
          }),
          { externalUserId: 'discord-1', userId: 143 },
        );

        expect(result).toEqual({
          error: 'calendarId 42 không có trong lịch sắp tới.',
        });
        expect(confirmSender).not.toHaveBeenCalled();
      });
    });
  });

  describe('zalo behavior', () => {
    beforeEach(() => {
      service = new PlatformAgentToolsService(
        buildGoalsService(),
        buildCalendarService(),
        stagePort,
        buildZaloOptions(confirmSender),
      );
    });

    it('returns available:false with a link-account message including the OAuth URL when unlinked', async () => {
      const ctx: PlatformAgentToolContext = { externalUserId: 'zalo-1' };
      const result = (await service.execute('get_user_goals', '{}', ctx)) as {
        available: boolean;
        message: string;
      };
      expect(result.available).toBe(false);
      expect(result.message).toContain('liên kết');
      expect(result.message).toContain('oauth.zaloapp.com/v4/permission');
    });

    it('returns goals when userId is linked', async () => {
      const ctx: PlatformAgentToolContext = {
        externalUserId: 'zalo-1',
        userId: 42,
      };
      const result = (await service.execute('get_user_goals', '{}', ctx)) as {
        targetBand: string;
      };
      expect(result.targetBand).toBe('7.0');
    });

    it('calls the Wispace API with the WISPACE userId (zalo historical behavior)', async () => {
      const goalsSpy = jest.spyOn(goalsService, 'getUserGoals');
      const goalsServiceWithSpy = {
        getUserGoals: goalsSpy,
        getTaskScoreAverages: jest.fn(),
      };
      const zaloService = new PlatformAgentToolsService(
        goalsServiceWithSpy as unknown as WispaceGoalsService,
        buildCalendarService(),
        stagePort,
        buildZaloOptions(confirmSender),
      );

      await zaloService.execute('get_user_goals', '{}', {
        externalUserId: 'zalo-1',
        userId: 42,
      });

      expect(goalsSpy).toHaveBeenCalledWith('42');
    });

    it('returns formatted report for learning progress', async () => {
      const ctx: PlatformAgentToolContext = {
        externalUserId: 'zalo-1',
        userId: 42,
      };
      const result = (await service.execute(
        'get_learning_progress_report',
        '{}',
        ctx,
      )) as string;
      expect(result).toContain('Báo cáo tiến độ');
      expect(result).toContain('7.0');
    });

    it('returns an error object for an unknown tool name', async () => {
      const ctx: PlatformAgentToolContext = { externalUserId: 'zalo-1' };
      const result = (await service.execute('not_a_real_tool', '{}', ctx)) as {
        error: string;
      };
      expect(result.error).toContain('Unknown tool');
    });

    it('reschedule: skips date/time validation and sends text confirmation with reply hint', async () => {
      stagePort.stage.mockResolvedValue({
        pendingConfirmation: true,
        sessionLabel: 'Ngày mai lúc 19:00',
        summary: 'Dời buổi Ngày mai lúc 19:00 sang ngày kế tiếp cùng giờ?',
      });

      const result = await service.execute(
        'reschedule_study_session',
        JSON.stringify({
          calendarId: 42,
          schedulingMode: 'default_next_day_same_time',
          newLocalDate: 'not-a-date',
          newTime: '9am',
        }),
        { externalUserId: 'zalo-1', userId: 42 },
      );

      expect(stagePort.stage).toHaveBeenCalledWith({
        externalId: 'zalo-1',
        userId: 42,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
        newLocalDate: undefined,
        newTime: undefined,
      });
      expect(confirmSender).toHaveBeenCalledWith(
        'zalo-1',
        'Dời buổi Ngày mai lúc 19:00 sang ngày kế tiếp cùng giờ?',
      );
      expect(result).toEqual({
        pendingConfirmation: true,
        sessionLabel: 'Ngày mai lúc 19:00',
      });
    });

    it('reschedule: returns Vietnamese validation errors before staging', async () => {
      const result = await service.execute('reschedule_study_session', '{}', {
        externalUserId: 'zalo-1',
        userId: 42,
      });

      expect(result).toEqual({
        error: 'calendarId (số nguyên dương) là bắt buộc.',
      });
      expect(stagePort.stage).not.toHaveBeenCalled();
    });
  });
});
