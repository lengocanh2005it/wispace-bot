import { LlmAgentService } from '@wispace/llm-agent/core';
import type {
  LlmProviderAdapter,
  LlmToolChatRequest,
  LlmToolChatResponse,
} from '@wispace/llm-agent/provider';
import { PlatformAgentToolsService } from './platform-agent-tools.service';
import type {
  CalendarCapabilityPort,
  GoalsCapabilityPort,
} from './wispace-capability.ports';
import type {
  PlatformAgentToolContext,
  PlatformAgentToolsOptions,
  RescheduleStagePort,
} from './platform-agent.types';

function toolResponse(toolName: string, argsJson: string): LlmToolChatResponse {
  return {
    message: {
      role: 'assistant',
      toolCalls: [{ id: 'call-1', name: toolName, arguments: argsJson }],
    },
    content: undefined,
    metadata: {
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'test-response',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  };
}

function textResponse(text: string): LlmToolChatResponse {
  return {
    message: { role: 'assistant', content: text },
    content: text,
    metadata: {
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'test-response',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
  };
}

function buildAdapter(
  first: LlmToolChatResponse,
  second: LlmToolChatResponse,
  requests: LlmToolChatRequest[],
): LlmProviderAdapter {
  const responses = [first, second];
  let index = 0;
  return {
    providerName: 'openai',
    isConfigured: () => true,
    getDefaultModel: () => 'gpt-5.4',
    generateJson: jest.fn(),
    chatWithTools: jest
      .fn()
      .mockImplementation((request: LlmToolChatRequest) => {
        requests.push(request);
        return Promise.resolve(responses[index++]);
      }),
    isRetryableError: () => false,
    isRateLimitError: () => false,
    normalizeError: () => ({
      provider: 'openai',
      retryable: false,
      reason: 'unknown',
    }),
  };
}

function goalsPort(): GoalsCapabilityPort {
  return {
    getUserGoals: async () => ({ targetScore: 7, examDate: '2026-08-01' }),
    getTaskScoreAverages: async () => [],
  };
}

function stagePort(): RescheduleStagePort {
  return {
    stage: async () => ({ error: 'not used' }),
  };
}

function buildOptions(
  identityProvider: PlatformAgentToolsOptions['currentIdentityProvider'],
): PlatformAgentToolsOptions {
  return {
    getNotLinkedMessage: () => 'not linked',
    wispaceExternalId: (ctx) => ctx.externalUserId,
    registerReportMessage: 'registered',
    currentIdentityProvider: identityProvider,
    reschedule: {
      validateDateAndTime: true,
      messages: {
        calendarIdRequired: 'calendarId is required',
        schedulingModeInvalid: 'invalid scheduling mode',
        newLocalDateInvalid: 'invalid date',
        newTimeInvalid: 'invalid time',
      },
      confirmSender: async () => undefined,
    },
  };
}

function buildAgent(
  adapter: LlmProviderAdapter,
  toolExecutor: PlatformAgentToolsService,
): LlmAgentService<PlatformAgentToolContext> {
  return new LlmAgentService(
    {
      maxLlmRetries: 0,
      maxInputTokens: 12_000,
    },
    {
      llmExecution: {
        run: async (fn) => fn(undefined, undefined),
      },
      usageRecorder: { recordFromCompletion: () => undefined },
      safetyEvents: {
        recordGroundingWarning: () => undefined,
        recordInjectionEvent: () => undefined,
      },
      toolExecutor,
      adapter,
    },
  );
}

function context(): PlatformAgentToolContext {
  return { externalUserId: 'discord-1', userText: 'cho mình xem lịch học' };
}

function calendarPort(
  sessions: Array<{ sessionKey: string; scheduledAt: string; topic: string }>,
): CalendarCapabilityPort {
  return {
    getCalendarSessions: jest.fn().mockResolvedValue(
      sessions.map((session) => ({
        ...session,
        scheduledAt: new Date(session.scheduledAt),
      })),
    ),
  };
}

describe('bounded calendar agent seam', () => {
  it('clamps upcoming requests through the real platform executor and preserves the bounded result', async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      sessionKey: `calendar:${index + 1}`,
      scheduledAt: '2026-08-01T07:00:00.000Z',
      topic: 'IELTS Writing',
    }));
    const calendar = calendarPort(sessions);
    const identity = jest.fn().mockResolvedValue({
      userId: 143,
      mappingVersion: 'test:discord-1',
    });
    const tools = new PlatformAgentToolsService(
      goalsPort(),
      calendar,
      stagePort(),
      buildOptions(identity),
    );
    const requests: LlmToolChatRequest[] = [];
    const agent = buildAgent(
      buildAdapter(
        toolResponse('get_upcoming_study_sessions', '{"limit":15}'),
        textResponse('Đây là toàn bộ lịch học.'),
        requests,
      ),
      tools,
    );

    const reply = await agent.reply(
      {
        externalUserId: 'discord-1',
        userText: 'cho mình xem 15 buổi học sắp tới',
        systemPrompt: 'test',
        correlationId: 'bounded-calendar-test',
      },
      context(),
    );

    expect(calendar.getCalendarSessions).toHaveBeenCalledWith(
      'discord-1',
      expect.objectContaining({ limit: 10, timeRange: 'upcoming' }),
    );
    expect(identity).toHaveBeenCalledTimes(1);
    const toolMessage = requests[1].messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toContain('"requestedLimit":15');
    expect(toolMessage?.content).toContain('"effectiveLimit":10');
    expect(reply.text).toContain('Mình đã lấy 10 mục');
    expect(reply.text).not.toContain('Đây là toàn bộ lịch học');
    expect(reply.toolSummary).toContain('requestedLimit=15');
  });

  it('discloses the past-day bound through the real platform executor', async () => {
    const calendar = calendarPort([]);
    const tools = new PlatformAgentToolsService(
      goalsPort(),
      calendar,
      stagePort(),
      buildOptions(async () => ({ userId: 143, mappingVersion: 'test' })),
    );
    const requests: LlmToolChatRequest[] = [];
    const agent = buildAgent(
      buildAdapter(
        toolResponse(
          'list_study_calendar_entries',
          '{"timeRange":"past","pastDays":9999}',
        ),
        textResponse('Không còn lịch học nào nữa.'),
        requests,
      ),
      tools,
    );

    const reply = await agent.reply(
      {
        externalUserId: 'discord-1',
        userText: 'cho mình xem toàn bộ lịch học trong nhiều năm qua',
        systemPrompt: 'test',
        correlationId: 'bounded-history-test',
      },
      context(),
    );

    expect(calendar.getCalendarSessions).toHaveBeenCalledWith(
      'discord-1',
      expect.objectContaining({ pastDays: 365, timeRange: 'past' }),
    );
    const toolMessage = requests[1].messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toContain('"effectivePastDays":365');
    expect(reply.text).toContain('365 ngày gần nhất');
    expect(reply.text).not.toContain('Không còn lịch học nào nữa');
  });

  const invalidCalendarCases: Array<[string, Record<string, unknown>]> = [
    ['get_upcoming_study_sessions', { limit: true }],
    ['get_upcoming_study_sessions', { limit: '15' }],
    ['get_upcoming_study_sessions', { limit: 1.5 }],
    ['get_upcoming_study_sessions', { limit: 0 }],
    ['get_upcoming_study_sessions', { limit: -1 }],
    ['list_study_calendar_entries', { timeRange: 'past', pastDays: '9999' }],
    ['list_study_calendar_entries', { timeRange: 'past', pastDays: 1.5 }],
    ['list_study_calendar_entries', { timeRange: 'past', pastDays: 0 }],
    ['list_study_calendar_entries', { timeRange: 'past', pastDays: -1 }],
  ];

  it.each(invalidCalendarCases)(
    'rejects invalid %s arguments before real identity or calendar calls',
    async (toolName, args) => {
      const identity = jest.fn();
      const calendar = calendarPort([]);
      const tools = new PlatformAgentToolsService(
        goalsPort(),
        calendar,
        stagePort(),
        buildOptions(identity),
      );
      const requests: LlmToolChatRequest[] = [];
      const agent = buildAgent(
        buildAdapter(
          toolResponse(toolName, JSON.stringify(args)),
          textResponse('Mình cần tra cứu dữ liệu.'),
          requests,
        ),
        tools,
      );

      const reply = await agent.reply(
        {
          externalUserId: 'discord-1',
          userText: 'cho mình xem lịch học',
          systemPrompt: 'test',
          correlationId: `invalid-args-${toolName}`,
        },
        context(),
      );
      const toolMessage = requests[1].messages.find(
        (message) => message.role === 'tool',
      );

      expect(identity).not.toHaveBeenCalled();
      expect(calendar.getCalendarSessions).not.toHaveBeenCalled();
      expect(toolMessage?.content).toMatch(
        /Invalid tool argument: (limit|pastDays)/,
      );
      const rawValue = args.limit ?? args.pastDays;
      expect(toolMessage?.content).not.toContain(JSON.stringify(rawValue));
      expect(reply.text).toContain('Mình cần tra cứu dữ liệu');
    },
  );

  it('accepts a valid positive calendar id through identity and staging', async () => {
    const identity = jest.fn().mockResolvedValue({
      userId: 143,
      mappingVersion: 'test:discord-1',
    });
    const stage = stagePort();
    const stageSpy = jest.spyOn(stage, 'stage').mockResolvedValue({
      pendingConfirmation: true,
      confirmationToken: 'approval-token',
      summary: 'Yêu cầu dời lịch',
      sessionLabel: 'Buổi học ngày mai',
    });
    const tools = new PlatformAgentToolsService(
      goalsPort(),
      calendarPort([]),
      stage,
      buildOptions(identity),
    );
    const requests: LlmToolChatRequest[] = [];
    const agent = buildAgent(
      buildAdapter(
        toolResponse(
          'reschedule_study_session',
          JSON.stringify({
            calendarId: 42,
            schedulingMode: 'default_next_day_same_time',
          }),
        ),
        textResponse('Mình đã gửi yêu cầu đổi lịch.'),
        requests,
      ),
      tools,
    );

    const reply = await agent.reply(
      {
        externalUserId: 'discord-1',
        userText: 'đổi lịch buổi học',
        systemPrompt: 'test',
        correlationId: 'valid-calendar-id',
      },
      { ...context(), userText: 'đổi lịch buổi học' },
    );

    expect(identity).toHaveBeenCalledTimes(1);
    expect(stageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 42, userId: 143 }),
    );
    expect(reply.text).toContain('Mình đã gửi yêu cầu đổi lịch');
  });

  it.each([0, -1, 1.5, '1', true])(
    'rejects invalid calendar id %p before real identity or stage lookup',
    async (calendarId) => {
      const identity = jest.fn();
      const stage = stagePort();
      const stageSpy = jest.spyOn(stage, 'stage');
      const tools = new PlatformAgentToolsService(
        goalsPort(),
        calendarPort([]),
        stage,
        buildOptions(identity),
      );
      const requests: LlmToolChatRequest[] = [];
      const agent = buildAgent(
        buildAdapter(
          toolResponse(
            'reschedule_study_session',
            JSON.stringify({ calendarId, schedulingMode: 'explicit' }),
          ),
          textResponse('Mình cần tra cứu dữ liệu.'),
          requests,
        ),
        tools,
      );

      const reply = await agent.reply(
        {
          externalUserId: 'discord-1',
          userText: 'đổi lịch buổi học',
          systemPrompt: 'test',
          correlationId: `invalid-calendar-id-${String(calendarId)}`,
        },
        context(),
      );

      expect(identity).not.toHaveBeenCalled();
      expect(stageSpy).not.toHaveBeenCalled();
      const toolMessage = requests[1].messages.find(
        (message) => message.role === 'tool',
      );
      expect(toolMessage?.content).not.toContain(JSON.stringify(calendarId));
      expect(reply.text).toContain('Mình cần tra cứu dữ liệu');
    },
  );
});
