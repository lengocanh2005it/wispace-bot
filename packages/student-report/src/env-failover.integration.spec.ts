import {
  createEnvLlmExecutionPort,
  createLlmProviderAdapterFromEnv,
  OpenAiAdapter,
  type EnvLlmExecutionConfig,
  type LlmJsonResponse,
} from '@wispace/llm-agent';
import { StudentReportCore } from './student-report.service';

const capacityInput = {
  exam_date: '2026-08-01',
  exam_date_display: '01/08/2026',
  current_date: '2026-07-01',
  days_until_exam: 31,
  exam_has_passed: false,
  target_band: 7,
  task1_band: 6,
  task2_band: 6.5,
  total_essays_task1: 5,
  total_essays_task2: 4,
};

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

describe('env provider failover → execution port → student report', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('moves from a failed primary to the configured secondary and preserves actual metadata', async () => {
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
      content: JSON.stringify({ headline: 'Tổng hợp từ provider phụ' }),
      metadata: {
        provider: 'openrouter',
        model: 'openrouter/secondary',
        responseId: 'secondary-response',
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
    const usageRecorder = { recordFromCompletion: jest.fn() };
    const core = new StudentReportCore(
      { adapter, systemPrompt: 'report prompt' },
      {
        llmExecution: execution,
        usageRecorder,
        capacityData: {
          getCapacityData: jest.fn().mockResolvedValue(capacityInput),
        },
        platform: 'discord',
      },
    );

    const report = await core.generateReport('discord-user', {
      correlationId: 'report-correlation',
    });

    expect(report).toContain('Tổng hợp từ provider phụ');
    expect(providerAttempts).toEqual(['openai', 'openrouter']);
    expect(usageRecorder.recordFromCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openrouter',
        model: 'openrouter/secondary',
        correlationId: 'report-correlation',
      }),
    );
  });
});
