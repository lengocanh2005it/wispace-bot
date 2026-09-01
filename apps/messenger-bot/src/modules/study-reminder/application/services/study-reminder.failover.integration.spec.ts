import {
  createEnvLlmExecutionPort,
  createLlmProviderAdapterFromEnv,
  OpenAiAdapter,
  type EnvLlmExecutionConfig,
  type LlmJsonResponse,
} from '@wispace/llm-agent';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudyReminderService } from './study-reminder.service';

const executionConfig: EnvLlmExecutionConfig = {
  enabled: true,
  maxConcurrent: 1,
  globalMaxConcurrent: 1,
  maxAttempts: 1,
  baseBackoffMs: 1,
  retryMaxDelayMs: 10_000,
  requestTimeoutMs: 5_000,
  globalConcurrencyEnabled: false,
  redis: null,
  maxQueueDepth: 2,
  chatAdmissionWaitMs: 100,
  backgroundAdmissionWaitMs: 100,
};

describe('env provider failover → execution port → study reminder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the secondary provider while keeping the reminder server-time contract', async () => {
    const env: Record<string, string> = {
      LLM_PROVIDER_FAILOVER_ORDER: 'openai,openrouter',
      OPENAI_API_KEY: 'primary-key',
      OPENAI_MODEL: 'gpt-primary',
      OPENROUTER_API_KEY: 'secondary-key',
      OPENROUTER_MODEL: 'openrouter/secondary',
      LLM_OPENAI_RETRY_MAX_ATTEMPTS: '1',
      LLM_FAILOVER_COOLDOWN_SHORT_MS: '1',
    };
    const adapter = createLlmProviderAdapterFromEnv((key) => env[key]);
    const providerAttempts: string[] = [];
    const response: LlmJsonResponse = {
      content: JSON.stringify({
        greeting: 'Chào Mai,',
        intro: 'Mình nhắc bạn về buổi học nhé.',
        scheduledTime: '23:59 31/12/2099',
        tasks: ['Ôn feedback', 'Luyện Task 2', 'Soát lỗi ngữ pháp'],
        motivation: 'Cố thêm một chút là tiến bộ rõ hơn.',
        signoff: 'Cố lên nhé!',
      }),
      metadata: {
        provider: 'openrouter',
        model: 'openrouter/secondary',
        responseId: 'secondary-reminder-response',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    };

    jest
      .spyOn(OpenAiAdapter.prototype, 'generateJson')
      .mockImplementation(function (this: OpenAiAdapter, request) {
        providerAttempts.push(this.providerName);
        if (this.providerName === 'openai') {
          return Promise.reject(
            Object.assign(new Error('primary unavailable'), { status: 503 }),
          );
        }
        return Promise.resolve({
          ...response,
          metadata: {
            ...response.metadata,
            provider: this.providerName,
            model: request.model ?? this.getDefaultModel(),
          },
        });
      });

    const execution = createEnvLlmExecutionPort(executionConfig, adapter, {
      warn: jest.fn(),
    });
    const service = new StudyReminderService(
      { getUpcomingSessions: jest.fn() } as never,
      {
        getMinutesUntilSession: jest.fn(() => 60),
        formatScheduledTimeLabel: jest.fn(() => '09:00 01/07/2026'),
      } as unknown as StudyReminderScheduleService,
      {
        getUserGoals: jest.fn().mockResolvedValue({ targetScore: 7 }),
        getCapacityData: jest.fn().mockResolvedValue({}),
      },
      { resolveDisplayName: jest.fn().mockResolvedValue('Mai') } as never,
      { recordFromCompletion: jest.fn() } as never,
      execution as never,
      adapter,
    );

    const result = await service.generateReminderForSession(
      'zalo-or-messenger-user',
      {
        sessionKey: 'session-1',
        scheduledAt: new Date('2026-07-01T02:00:00.000Z'),
        topic: 'Task 2',
      },
    );

    expect(providerAttempts).toEqual(['openai', 'openrouter']);
    expect(result).toContain('09:00 01/07/2026');
    expect(result).not.toContain('23:59 31/12/2099');
  });
});
