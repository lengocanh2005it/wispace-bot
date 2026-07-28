import type { LlmUsageRepositoryPort } from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageRecorderService } from './llm-usage-recorder.service';
import type { LlmUsageConfigService } from './llm-usage-config.service';

describe('LlmUsageRecorderService', () => {
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

    const service = new LlmUsageRecorderService(configService, repository);
    service.recordFromCompletion({
      feature: 'FREE_FORM_CHAT',
      psid: 'psid-1',
      model: 'gpt-5.4',
      response: {
        id: 'resp-1',
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
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

    const service = new LlmUsageRecorderService(configService, repository);
    service.recordUsage({
      feature: 'FREE_FORM_CHAT',
      model: 'gpt-5.4',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });

    expect(insertUsage).not.toHaveBeenCalled();
  });
});
