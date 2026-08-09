import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { MESSENGER_REPOSITORY } from '@messenger/modules/messenger/domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '@messenger/modules/messenger/domain/repositories/messenger-mapping.repository.port';
import type {
  LlmUsageAggregateRow,
  LlmUsageFeatureSummary,
  LlmUsageFleetSummary,
  LlmUsageUserSummary,
} from '../../domain/entities/llm-usage-summary.types';
import {
  LLM_USAGE_REPOSITORY,
  type LlmUsageRepositoryPort,
} from '../../domain/repositories/llm-usage.repository.port';
import { addCostUsdStrings } from '@wispace/chat-metering';
import { LlmUsageConfigService } from './llm-usage-config.service';

const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class LlmUsageQueryService {
  constructor(
    private readonly configService: LlmUsageConfigService,
    @Inject(LLM_USAGE_REPOSITORY)
    private readonly usageRepository: LlmUsageRepositoryPort,
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerMappingRepositoryPort,
  ) {}

  async getUserSummary(input: {
    psid?: string;
    userId?: number;
    from?: string;
    to?: string;
  }): Promise<LlmUsageUserSummary> {
    const psid = input.psid?.trim() || undefined;
    const userId =
      input.userId !== undefined && Number.isFinite(input.userId)
        ? Math.floor(input.userId)
        : undefined;

    if (!psid && userId === undefined) {
      throw new BadRequestException('psid or userId is required');
    }

    const timezone = this.configService.getTimezone();
    const toDate =
      this.parseUsageDate(input.to) ?? this.configService.todayUsageDate();
    const fromDate = this.parseUsageDate(input.from) ?? toDate;

    if (fromDate > toDate) {
      throw new BadRequestException('from must be on or before to');
    }

    const mapping = await this.resolveMapping(psid, userId);
    const rows = await this.usageRepository.aggregateUsage({
      psid,
      userId,
      fromDate,
      toDate,
    });

    const byFeature = this.groupByFeature(rows);
    const totals = this.sumFeatureSummaries(byFeature);

    return {
      psid: psid ?? mapping?.psid ?? null,
      userId: userId ?? mapping?.userId ?? null,
      from: fromDate,
      to: toDate,
      timezone,
      byFeature,
      totals,
      disclaimer: this.configService.getCostDisclaimer(),
    };
  }

  async getFleetSummary(input: {
    date?: string;
  }): Promise<LlmUsageFleetSummary> {
    const timezone = this.configService.getTimezone();
    const usageDate =
      this.parseUsageDate(input.date) ?? this.configService.todayUsageDate();

    const rows = await this.usageRepository.aggregateFleetByDate(usageDate);
    const byFeature = this.groupByFeature(rows);
    const totals = this.sumFeatureSummaries(byFeature);

    return {
      date: usageDate,
      timezone,
      byFeature,
      totals,
      disclaimer: this.configService.getCostDisclaimer(),
    };
  }

  private async resolveMapping(psid?: string, userId?: number) {
    if (psid) {
      return this.messengerRepository.findActiveMappingByPsid(psid);
    }

    if (userId !== undefined) {
      return this.messengerRepository.findActiveMappingByUserId(userId);
    }

    return null;
  }

  private parseUsageDate(value?: string): string | null {
    const trimmed = value?.trim();
    if (!trimmed) {
      return null;
    }

    if (!USAGE_DATE_PATTERN.test(trimmed)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }

    return trimmed;
  }

  private groupByFeature(
    rows: LlmUsageAggregateRow[],
  ): LlmUsageFeatureSummary[] {
    const grouped = new Map<string, LlmUsageFeatureSummary>();

    for (const row of rows) {
      const existing = grouped.get(row.feature) ?? {
        feature: row.feature,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        estimatedCostUsd: null as string | null,
      };

      existing.calls += row.calls;
      existing.promptTokens += row.promptTokens;
      existing.completionTokens += row.completionTokens;
      existing.totalTokens += row.totalTokens;
      existing.cachedTokens += row.cachedTokens;
      existing.estimatedCostUsd = addCostUsdStrings(
        existing.estimatedCostUsd,
        this.estimateRowCostUsd(row),
      );

      grouped.set(row.feature, existing);
    }

    return [...grouped.values()].sort((a, b) =>
      String(a.feature).localeCompare(String(b.feature)),
    );
  }

  private estimateRowCostUsd(row: LlmUsageAggregateRow): string | null {
    const unstoredCost =
      row.unstoredPromptTokens === 0 && row.unstoredCompletionTokens === 0
        ? null
        : this.configService.estimateCostUsdForModel(
            row.model,
            row.unstoredPromptTokens,
            row.unstoredCompletionTokens,
            row.unstoredCachedTokens,
          );

    return addCostUsdStrings(row.storedCostUsd, unstoredCost);
  }

  private sumFeatureSummaries(
    summaries: LlmUsageFeatureSummary[],
  ): Omit<LlmUsageFeatureSummary, 'feature'> {
    return summaries.reduce(
      (acc, row) => ({
        calls: acc.calls + row.calls,
        promptTokens: acc.promptTokens + row.promptTokens,
        completionTokens: acc.completionTokens + row.completionTokens,
        totalTokens: acc.totalTokens + row.totalTokens,
        cachedTokens: acc.cachedTokens + row.cachedTokens,
        estimatedCostUsd: addCostUsdStrings(
          acc.estimatedCostUsd,
          row.estimatedCostUsd,
        ),
      }),
      {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        estimatedCostUsd: null as string | null,
      },
    );
  }
}
