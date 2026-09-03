import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MESSENGER_REPOSITORY } from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import { LLM_USAGE_REPOSITORY } from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageConfigService } from './llm-usage-config.service';
import { LlmUsageQueryService } from './llm-usage-query.service';

describe('LlmUsageQueryService', () => {
  const aggregateUsage = jest.fn();
  const aggregateFleetByDate = jest.fn();
  const findActiveMappingByPsid = jest.fn();
  const findActiveMappingByUserId = jest.fn();

  let service: LlmUsageQueryService;

  beforeEach(async () => {
    aggregateUsage.mockReset();
    aggregateFleetByDate.mockReset();
    findActiveMappingByPsid.mockReset();
    findActiveMappingByUserId.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmUsageQueryService,
        {
          provide: LlmUsageConfigService,
          useValue: {
            getTimezone: () => 'Asia/Ho_Chi_Minh',
            todayUsageDate: () => '2026-06-18',
            estimateCostUsdForModel: () => '0.010000',
            getCostDisclaimer: () => 'test disclaimer',
          },
        },
        {
          provide: LLM_USAGE_REPOSITORY,
          useValue: {
            aggregateUsage,
            aggregateFleetByDate,
          },
        },
        {
          provide: MESSENGER_REPOSITORY,
          useValue: {
            findActiveMappingByPsid,
            findActiveMappingByUserId,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(LlmUsageQueryService);
  });

  it('requires psid or userId', async () => {
    await expect(service.getUserSummary({})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('aggregates usage by psid without forcing mapped userId filter', async () => {
    findActiveMappingByPsid.mockResolvedValue({
      psid: 'psid-1',
      userId: 42,
    });
    aggregateUsage.mockResolvedValue([
      {
        feature: 'FREE_FORM_CHAT',
        model: 'gpt-5.4',
        calls: 2,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        storedCostUsd: '0.010000',
        unstoredPromptTokens: 0,
        unstoredCompletionTokens: 0,
      },
    ]);

    const result = await service.getUserSummary({ psid: 'psid-1' });

    expect(aggregateUsage).toHaveBeenCalledWith({
      psid: 'psid-1',
      userId: undefined,
      fromDate: '2026-06-18',
      toDate: '2026-06-18',
    });
    expect(result.userId).toBe(42);
    expect(result.totals.totalTokens).toBe(150);
    expect(result.totals.estimatedCostUsd).toBe('0.010000');
  });

  it('returns fleet summary for a date', async () => {
    aggregateFleetByDate.mockResolvedValue([]);

    const result = await service.getFleetSummary({ date: '2026-06-17' });

    expect(aggregateFleetByDate).toHaveBeenCalledWith('2026-06-17');
    expect(result.date).toBe('2026-06-17');
    expect(result.totals.calls).toBe(0);
  });

  it('surfaces per-feature cache hit-rate in fleet summaries (#553)', async () => {
    aggregateFleetByDate.mockResolvedValue([
      {
        feature: 'STUDY_REMINDER',
        model: 'gpt-5.4',
        calls: 2,
        promptTokens: 200,
        completionTokens: 10,
        totalTokens: 210,
        cachedTokens: 150,
        storedCostUsd: '0.001000',
        unstoredPromptTokens: 0,
        unstoredCompletionTokens: 0,
        unstoredCachedTokens: 0,
      },
      {
        feature: 'FREE_FORM_CHAT',
        model: 'gpt-5.4',
        calls: 1,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        storedCostUsd: null,
        unstoredPromptTokens: 0,
        unstoredCompletionTokens: 0,
        unstoredCachedTokens: 0,
      },
    ]);

    const result = await service.getFleetSummary({ date: '2026-06-17' });

    const reminder = result.byFeature.find(
      (row) => row.feature === 'STUDY_REMINDER',
    );
    expect(reminder?.cacheHitRate).toBeCloseTo(0.75);
    const chat = result.byFeature.find(
      (row) => row.feature === 'FREE_FORM_CHAT',
    );
    expect(chat?.cacheHitRate).toBeNull();
    expect(result.totals.cacheHitRate).toBeCloseTo(150 / 200);
  });
});
