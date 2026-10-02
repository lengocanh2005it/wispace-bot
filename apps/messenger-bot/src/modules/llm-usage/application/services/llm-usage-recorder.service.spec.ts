import type { BotMetricsService } from '@wispace/bot-metrics';
import type { LlmUsageRepositoryPort } from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageRecorderService } from './llm-usage-recorder.service';
import type { LlmUsageConfigService } from './llm-usage-config.service';

describe('LlmUsageRecorderService', () => {
  const metrics = {
    incLlmUsageInsertFailure: jest.fn(),
    incLlmMissingTokens: jest.fn(),
    incLlmUnpricedModelTokens: jest.fn(),
  } as unknown as BotMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function createService(
    insertUsage: LlmUsageRepositoryPort['insertUsage'],
  ): LlmUsageRecorderService {
    const repository: LlmUsageRepositoryPort = {
      insertUsage,
      deleteOlderThan: jest.fn(),
      aggregateUsage: jest.fn(),
      aggregateFleetByDate: jest.fn(),
    };
    const configService = {
      isEnabled: () => true,
      todayUsageDate: () => '2026-06-18',
      estimateCostUsdForModel: () => '0.001500',
    } as unknown as LlmUsageConfigService;
    return new LlmUsageRecorderService(configService, repository, metrics);
  }

  function recordBothUsagePaths(service: LlmUsageRecorderService): void {
    service.recordFromCompletion({
      feature: 'FREE_FORM_CHAT',
      psid: 'psid-core',
      model: 'gpt-5.4',
      response: {
        id: 'resp-core',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
      correlationId: 'core-correlation',
      toolRound: 0,
    });
    service.recordUsage({
      feature: 'STUDY_REMINDER',
      psid: 'psid-direct',
      model: 'gpt-5.4',
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      correlationId: 'direct-correlation',
    });
  }

  it('inserts usage directly to DB', () => {
    const insertUsage = jest.fn().mockResolvedValue(undefined);
    const repository: LlmUsageRepositoryPort = {
      insertUsage,
      deleteOlderThan: jest.fn(),
      aggregateUsage: jest.fn(),
      aggregateFleetByDate: jest.fn(),
    };
    const configService = {
      isEnabled: () => true,
      todayUsageDate: () => '2026-06-18',
      estimateCostUsdForModel: () => '0.001500',
    } as unknown as LlmUsageConfigService;

    const service = new LlmUsageRecorderService(
      configService,
      repository,
      metrics,
    );
    service.recordFromCompletion({
      feature: 'FREE_FORM_CHAT',
      psid: 'psid-1',
      model: 'gpt-5.4',
      response: {
        id: 'resp-1',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      },
      correlationId: 'mid-1',
      toolRound: 0,
    });

    expect(insertUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'FREE_FORM_CHAT',
        psid: 'psid-1',
        usageDate: '2026-06-18',
        totalTokens: 3,
        openaiResponseId: 'resp-1',
      }),
    );
  });

  it('skips insert when LLM usage tracking is disabled', () => {
    const insertUsage = jest.fn().mockResolvedValue(undefined);
    const repository: LlmUsageRepositoryPort = {
      insertUsage,
      deleteOlderThan: jest.fn(),
      aggregateUsage: jest.fn(),
      aggregateFleetByDate: jest.fn(),
    };
    const configService = {
      isEnabled: () => false,
      todayUsageDate: () => '2026-06-18',
    } as unknown as LlmUsageConfigService;

    const service = new LlmUsageRecorderService(
      configService,
      repository,
      metrics,
    );
    service.recordUsage({
      feature: 'FREE_FORM_CHAT',
      model: 'gpt-5.4',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });

    expect(insertUsage).not.toHaveBeenCalled();
  });

  it('inserts zero-token failure row and suppresses incMissingTokens (#1380)', () => {
    const insertUsage = jest.fn().mockResolvedValue(undefined);
    const repository: LlmUsageRepositoryPort = {
      insertUsage,
      deleteOlderThan: jest.fn(),
      aggregateUsage: jest.fn(),
      aggregateFleetByDate: jest.fn(),
    };
    const configService = {
      isEnabled: () => true,
      todayUsageDate: () => '2026-06-18',
      estimateCostUsdForModel: () => '0.000000',
    } as unknown as LlmUsageConfigService;

    const service = new LlmUsageRecorderService(
      configService,
      repository,
      metrics,
    );
    service.recordFromCompletion({
      feature: 'STUDY_REMINDER',
      psid: 'psid-1',
      userId: 42,
      model: 'gpt-5.4',
      response: {
        id: '',
        usage: null,
      },
      correlationId: 'rem-1',
      toolRound: 0,
      status: 'error',
      errorMessage: 'timeout',
    });

    expect(insertUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'STUDY_REMINDER',
        psid: 'psid-1',
        userId: 42,
        model: 'gpt-5.4',
        usageDate: '2026-06-18',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        status: 'error',
        errorMessage: 'timeout',
      }),
    );
    expect(metrics.incLlmMissingTokens).not.toHaveBeenCalled();
  });

  it('retries both Messenger insert paths after a transient DB error', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const insertUsage = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary DB error'))
      .mockRejectedValueOnce(new Error('temporary DB error'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const service = createService(insertUsage);
    recordBothUsagePaths(service);

    await jest.runAllTicks();
    expect(insertUsage).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(250);
    await jest.runAllTicks();

    expect(insertUsage).toHaveBeenCalledTimes(4);
    expect(insertUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        feature: 'FREE_FORM_CHAT',
        psid: 'psid-core',
        usageDate: '2026-06-18',
        openaiResponseId: 'resp-core',
      }),
    );
    expect(insertUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        feature: 'STUDY_REMINDER',
        psid: 'psid-direct',
        usageDate: '2026-06-18',
        correlationId: 'direct-correlation',
      }),
    );
    expect(metrics.incLlmUsageInsertFailure).not.toHaveBeenCalled();
  });

  it('increments the insert failure metric once per lost row after retry', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const insertUsage = jest.fn().mockRejectedValue(new Error('db down'));
    const service = createService(insertUsage);
    recordBothUsagePaths(service);

    await jest.runAllTicks();
    jest.advanceTimersByTime(250);
    await jest.runAllTicks();

    expect(insertUsage).toHaveBeenCalledTimes(4);
    expect(metrics.incLlmUsageInsertFailure).toHaveBeenCalledTimes(2);
    expect(metrics.incLlmUsageInsertFailure).toHaveBeenNthCalledWith(
      1,
      'db_error',
    );
    expect(metrics.incLlmUsageInsertFailure).toHaveBeenNthCalledWith(
      2,
      'db_error',
    );
  });

  it('disposes the shared writer on shutdown and cancels pending retries', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const insertUsage = jest.fn().mockRejectedValue(new Error('db down'));
    const service = createService(insertUsage);
    recordBothUsagePaths(service);

    await jest.runAllTicks();
    expect(insertUsage).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
    jest.advanceTimersByTime(500);
    await jest.runAllTicks();

    expect(insertUsage).toHaveBeenCalledTimes(2);
    expect(metrics.incLlmUsageInsertFailure).not.toHaveBeenCalled();
  });
});
