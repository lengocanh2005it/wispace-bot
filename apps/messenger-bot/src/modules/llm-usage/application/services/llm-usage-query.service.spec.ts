import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MESSENGER_MAPPING_READER } from '@messenger/shared/ports/messenger-mapping-reader.port';
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
          provide: MESSENGER_MAPPING_READER,
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
});
