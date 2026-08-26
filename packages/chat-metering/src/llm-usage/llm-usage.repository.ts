import type { Repository } from 'typeorm';
import { Counter } from 'prom-client';
import type { LlmUsageEventEntity } from '../entities/llm-usage-event.entity';
import type {
  LlmUsageAggregateRow,
  LlmUsageQueryFilter,
  RecordLlmUsageInput,
} from './types';

const llmUsageRetentionDeletedTotal = new Counter({
  name: 'llm_usage_retention_deleted_total',
  help: 'Total rows deleted by LLM usage retention cleanup',
});

interface AggregateQueryRow {
  feature: string;
  model: string;
  calls: string;
  prompt_tokens: string;
  completion_tokens: string;
  total_tokens: string;
  cached_tokens: string;
  stored_cost_usd: string | null;
  unstored_prompt_tokens: string;
  unstored_completion_tokens: string;
  unstored_cached_tokens: string;
}

export class LlmUsageRepository {
  constructor(
    private readonly usageRepo: Repository<LlmUsageEventEntity>,
    private readonly platform: string,
  ) {}

  async insertUsage(
    input: RecordLlmUsageInput & { usageDate: string },
  ): Promise<void> {
    await this.usageRepo.manager.query(
      `
        INSERT INTO llm_usage_events (
          usage_date,
          feature,
          platform,
          external_user_id,
          user_id,
          model,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          cached_tokens,
          openai_response_id,
          correlation_id,
          tool_round,
          status,
          error_message,
          estimated_cost_usd
        )
        VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        input.usageDate,
        input.feature,
        this.platform,
        input.externalUserId ?? null,
        input.userId ?? null,
        input.model,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
        input.cachedTokens ?? 0,
        input.openaiResponseId ?? null,
        input.correlationId ?? null,
        input.toolRound ?? null,
        input.status ?? 'ok',
        input.errorMessage ?? null,
        input.estimatedCostUsd ?? null,
      ],
    );
  }

  async deleteOlderThan(cutoff: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    // ponytail: bounded batch to avoid long-held locks on large tables.
    // The subquery selects a batch of matching IDs; the outer DELETE
    // removes exactly those rows. Loop exits when a partial batch signals
    // no more rows remain.
    for (;;) {
      const deleted: Array<{ id: string }> = await this.usageRepo.manager.query(
        `
            DELETE FROM llm_usage_events
            WHERE id IN (
              SELECT id FROM llm_usage_events
              WHERE platform = $1 AND occurred_at < $2
              LIMIT $3
            )
            RETURNING id
          `,
        [this.platform, cutoff, BATCH_SIZE],
      );

      totalDeleted += deleted.length;

      if (deleted.length < BATCH_SIZE) {
        break;
      }
    }

    if (totalDeleted > 0) {
      llmUsageRetentionDeletedTotal.inc(totalDeleted);
    }

    return totalDeleted;
  }

  async aggregateUsage(
    filter: LlmUsageQueryFilter,
  ): Promise<LlmUsageAggregateRow[]> {
    const { sql, params } = this.buildAggregateQuery(
      [
        'platform = $1',
        'usage_date >= $2::date',
        'usage_date <= $3::date',
        ...this.buildIdentityFilters(filter, 4),
      ],
      [this.platform, filter.fromDate, filter.toDate],
      filter,
    );

    const rows: AggregateQueryRow[] = await this.usageRepo.manager.query(
      sql,
      params,
    );

    return rows.map((row) => this.mapAggregateRow(row));
  }

  async aggregateFleetByDate(
    usageDate: string,
  ): Promise<LlmUsageAggregateRow[]> {
    const rows: AggregateQueryRow[] = await this.usageRepo.manager.query(
      this.buildAggregateSql(['platform = $1', 'usage_date = $2::date']),
      [this.platform, usageDate],
    );

    return rows.map((row) => this.mapAggregateRow(row));
  }

  private buildIdentityFilters(
    filter: LlmUsageQueryFilter,
    startIndex: number,
  ): string[] {
    const clauses: string[] = [];
    let index = startIndex;

    if (filter.externalUserId) {
      clauses.push(`external_user_id = $${index}`);
      index += 1;
    }

    if (filter.userId !== undefined) {
      clauses.push(`user_id = $${index}`);
      index += 1;
    }

    return clauses;
  }

  private buildAggregateQuery(
    whereClauses: string[],
    baseParams: unknown[],
    filter: LlmUsageQueryFilter,
  ): { sql: string; params: unknown[] } {
    const params = [...baseParams];

    if (filter.externalUserId) {
      params.push(filter.externalUserId);
    }

    if (filter.userId !== undefined) {
      params.push(filter.userId);
    }

    return {
      sql: this.buildAggregateSql(whereClauses),
      params,
    };
  }

  private buildAggregateSql(whereClauses: string[]): string {
    return `
      SELECT
        feature,
        model,
        COUNT(*)::text AS calls,
        COALESCE(SUM(prompt_tokens), 0)::text AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::text AS completion_tokens,
        COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
        COALESCE(SUM(cached_tokens), 0)::text AS cached_tokens,
        SUM(estimated_cost_usd)::text AS stored_cost_usd,
        COALESCE(SUM(prompt_tokens) FILTER (WHERE estimated_cost_usd IS NULL), 0)::text AS unstored_prompt_tokens,
        COALESCE(SUM(completion_tokens) FILTER (WHERE estimated_cost_usd IS NULL), 0)::text AS unstored_completion_tokens,
        COALESCE(SUM(cached_tokens) FILTER (WHERE estimated_cost_usd IS NULL), 0)::text AS unstored_cached_tokens
      FROM llm_usage_events
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY feature, model
      ORDER BY feature, model
    `;
  }

  private mapAggregateRow(row: AggregateQueryRow): LlmUsageAggregateRow {
    return {
      feature: row.feature,
      model: row.model,
      calls: Number(row.calls),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      cachedTokens: Number(row.cached_tokens),
      storedCostUsd: row.stored_cost_usd,
      unstoredPromptTokens: Number(row.unstored_prompt_tokens),
      unstoredCompletionTokens: Number(row.unstored_completion_tokens),
      unstoredCachedTokens: Number(row.unstored_cached_tokens),
    };
  }
}
