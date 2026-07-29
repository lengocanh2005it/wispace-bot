import { AGENT_TOOL_NAMES } from '@wispace/llm-agent';
import { DiscordAgentToolsService } from './discord-agent-tools.service';
import type { WispaceGoalsService } from '@discord/modules/wispace/application/services/wispace-goals.service';
import type { WispaceCalendarService } from '@discord/modules/wispace/application/services/wispace-calendar.service';
import type { DiscordRescheduleConfirmationService } from '../services/discord-reschedule-confirmation.service';
import type { DiscordOutboundService } from '../services/discord-outbound.service';

describe('DiscordAgentToolsService', () => {
  let goalsService: jest.Mocked<
    Pick<WispaceGoalsService, 'getUserGoals' | 'getTaskScoreAverages'>
  >;
  let calendarService: jest.Mocked<
    Pick<WispaceCalendarService, 'getCalendarSessions'>
  >;
  let rescheduleConfirmationService: jest.Mocked<
    Pick<DiscordRescheduleConfirmationService, 'stage'>
  >;
  let outboundService: jest.Mocked<
    Pick<DiscordOutboundService, 'sendRescheduleConfirmation'>
  >;
  let service: DiscordAgentToolsService;

  beforeEach(() => {
    goalsService = {
      getUserGoals: jest.fn(),
      getTaskScoreAverages: jest.fn(),
    };
    calendarService = {
      getCalendarSessions: jest.fn(),
    };
    rescheduleConfirmationService = {
      stage: jest.fn(),
    };
    outboundService = {
      sendRescheduleConfirmation: jest.fn(),
    };
    service = new DiscordAgentToolsService(
      goalsService as unknown as WispaceGoalsService,
      calendarService as unknown as WispaceCalendarService,
      rescheduleConfirmationService as unknown as DiscordRescheduleConfirmationService,
      outboundService as unknown as DiscordOutboundService,
    );
  });

  it('returns an error for an unknown tool name', async () => {
    const result = await service.execute('not_a_real_tool', '{}', {
      discordUserId: 'discord-1',
    });

    expect(result).toEqual({ error: 'Unknown tool: not_a_real_tool' });
  });

  it('returns available=false for every WISPACE tool when the Discord account is unlinked', async () => {
    for (const toolName of AGENT_TOOL_NAMES) {
      const result = await service.execute(toolName, '{}', {
        discordUserId: 'discord-1',
      });

      expect(result).toMatchObject({ available: false });
    }
  });

  it('get_user_goals calls WispaceGoalsService when linked', async () => {
    goalsService.getUserGoals.mockResolvedValue({
      targetScore: 7,
      examDate: '2026-08-01',
    });

    const result = await service.execute('get_user_goals', '{}', {
      discordUserId: 'discord-1',
      userId: 143,
    });

    expect(goalsService.getUserGoals).toHaveBeenCalledWith('discord-1');
    expect(result).toEqual({ targetScore: 7, examDate: '2026-08-01' });
  });

  it('get_learning_progress_report combines goals and task scores when linked', async () => {
    goalsService.getUserGoals.mockResolvedValue({
      targetScore: 7,
      examDate: '2026-08-01',
    });
    goalsService.getTaskScoreAverages.mockResolvedValue([]);

    const result = await service.execute('get_learning_progress_report', '{}', {
      discordUserId: 'discord-1',
      userId: 143,
    });

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

    const result = await service.execute('get_upcoming_study_sessions', '{}', {
      discordUserId: 'discord-1',
      userId: 143,
    });

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
      { discordUserId: 'discord-1', userId: 143 },
    );

    expect(calendarService.getCalendarSessions).toHaveBeenCalledWith(
      'discord-1',
      { timeRange: 'past', limit: 3, pastDays: 30 },
    );
  });

  it('preview_next_study_reminder reports hasSession=false when no sessions', async () => {
    calendarService.getCalendarSessions.mockResolvedValue([]);

    const result = await service.execute('preview_next_study_reminder', '{}', {
      discordUserId: 'discord-1',
      userId: 143,
    });

    expect(result).toEqual({ hasSession: false });
  });

  it('register_exam_report_notifications returns success when linked', async () => {
    const result = await service.execute(
      'register_exam_report_notifications',
      '{}',
      { discordUserId: 'discord-1', userId: 143 },
    );

    expect(result).toMatchObject({ registered: true });
  });

  it('register_exam_report_notifications returns not-linked message when unlinked', async () => {
    const result = await service.execute(
      'register_exam_report_notifications',
      '{}',
      { discordUserId: 'discord-1' },
    );

    expect(result).toMatchObject({ available: false });
  });

  describe('reschedule_study_session', () => {
    it('errors when calendarId is missing', async () => {
      const result = await service.execute(
        'reschedule_study_session',
        JSON.stringify({ schedulingMode: 'default_next_day_same_time' }),
        { discordUserId: 'discord-1', userId: 143 },
      );

      expect(result).toEqual({ error: 'calendarId is required' });
      expect(rescheduleConfirmationService.stage).not.toHaveBeenCalled();
    });

    it('errors when schedulingMode is invalid', async () => {
      const result = await service.execute(
        'reschedule_study_session',
        JSON.stringify({ calendarId: 1, schedulingMode: 'bogus' }),
        { discordUserId: 'discord-1', userId: 143 },
      );

      expect(result).toMatchObject({ error: expect.any(String) as string });
      expect(rescheduleConfirmationService.stage).not.toHaveBeenCalled();
    });

    it('stages the reschedule and sends a Discord confirmation DM when valid', async () => {
      rescheduleConfirmationService.stage.mockResolvedValue({
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
        { discordUserId: 'discord-1', userId: 143 },
      );

      expect(rescheduleConfirmationService.stage).toHaveBeenCalledWith({
        externalId: 'discord-1',
        userId: 143,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
        newLocalDate: undefined,
        newTime: undefined,
      });
      expect(outboundService.sendRescheduleConfirmation).toHaveBeenCalledWith(
        'discord-1',
        'Dời buổi Ngày mai lúc 19:00 sang ngày kế tiếp cùng giờ?',
      );
      expect(result).toEqual({
        pendingConfirmation: true,
        sessionLabel: 'Ngày mai lúc 19:00',
      });
    });

    it('returns the staging error without sending a confirmation DM', async () => {
      rescheduleConfirmationService.stage.mockResolvedValue({
        error: 'calendarId 42 không có trong lịch sắp tới.',
      });

      const result = await service.execute(
        'reschedule_study_session',
        JSON.stringify({
          calendarId: 42,
          schedulingMode: 'default_next_day_same_time',
        }),
        { discordUserId: 'discord-1', userId: 143 },
      );

      expect(result).toEqual({
        error: 'calendarId 42 không có trong lịch sắp tới.',
      });
      expect(outboundService.sendRescheduleConfirmation).not.toHaveBeenCalled();
    });
  });
});
