import { DataSource } from 'typeorm';
import {
  FUTURE_TIMESTAMP_RULES,
  NULL_SPIKE_RULES,
  ORPHAN_RULES,
  STUCK_STATE_RULES,
  TERMINAL_TIMESTAMP_RULES,
  VOLUME_RULES,
  type DataQualityTableRule,
} from './data-quality.catalog';
import type {
  DataQualityDatabasePort,
  DataQualityObservation,
  DataQualityQueryInput,
  DataQualityQueryPort,
  DataQualityRepositoryPort,
  DataQualitySample,
} from './data-quality.types';

interface DailyStatsRow {
  current_count: string | number | null;
  baseline_count: string | number | null;
  current_total: string | number | null;
  baseline_total: string | number | null;
}

interface SampleRow {
  anomaly_count?: string | number | null;
  sample_key?: string | null;
  user_id?: string | number | null;
  external_user_id?: string | null;
  platform?: string | null;
}

export class TypeormDataQualityDatabase implements DataQualityDatabasePort {
  constructor(private readonly dataSource: DataSource) {}

  async withReadOnly<T>(
    timeoutMs: number,
    operation: (query: DataQualityQueryPort) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${Math.max(1, Math.floor(timeoutMs))}ms`,
      ]);
      const query: DataQualityQueryPort = {
        query: async <R>(sql: string, parameters: readonly unknown[] = []) =>
          (await runner.query(sql, [...parameters])) as R[],
      };
      const result = await operation(query);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
  }
}

export class TypeormDataQualityRepository implements DataQualityRepositoryPort {
  constructor(private readonly database: DataQualityDatabasePort) {}

  async getNullSpikeObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    return this.getDailyObservations(
      NULL_SPIKE_RULES,
      input,
      (rule) => `t.${identifier(rule.userColumn!)} IS NULL`,
      (rule) => `t.${identifier(rule.userColumn!)} IS NULL`,
      'null',
      input.window.now.getTime() - input.config.nullResolutionAgeMs,
    );
  }

  async getFutureTimestampObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    const observations: DataQualityObservation[] = [];
    for (const rule of FUTURE_TIMESTAMP_RULES) {
      const result = await this.queryBadRows(
        rule,
        `${rule.condition ? `(${rule.condition}) AND ` : ''}${qualified(rule.timeColumn)} > $1::timestamptz + ($2::bigint * interval '1 millisecond')`,
        [input.window.now, input.config.futureSkewMs],
        input,
        rule.label,
      );
      observations.push({
        scope: rule.label,
        count: result.count,
        samples: result.samples,
      });
    }
    return observations;
  }

  async getTerminalTimestampObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    const observations: DataQualityObservation[] = [];
    for (const rule of TERMINAL_TIMESTAMP_RULES) {
      // ponytail: scan terminal rows under the 5s statement timeout; add
      // partial status/timestamp indexes if this check reaches the timeout.
      const result = await this.queryBadRows(
        rule,
        rule.terminalCondition,
        [],
        input,
        rule.label,
      );
      observations.push({
        scope: rule.label,
        count: result.count,
        samples: result.samples,
      });
    }
    return observations;
  }

  async getStuckStateObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    const observations: DataQualityObservation[] = [];
    for (const rule of STUCK_STATE_RULES) {
      const result = await this.queryBadRows(
        rule,
        rule.stuckCondition,
        rule.parameters({ now: input.window.now, config: input.config }),
        input,
        rule.label,
      );
      observations.push({
        scope: rule.label,
        count: result.count,
        samples: result.samples,
      });
    }
    return observations;
  }

  async getOrphanGrowthObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    return this.getDailyObservations(
      ORPHAN_RULES,
      input,
      (rule) => orphanPredicate(rule),
      (rule) => orphanPredicate(rule),
      'orphan',
    );
  }

  async getVolumeObservations(
    input: DataQualityQueryInput,
  ): Promise<DataQualityObservation[]> {
    return this.getDailyObservations(
      VOLUME_RULES,
      input,
      () => 'TRUE',
      () => 'TRUE',
      'volume',
    );
  }

  private async getDailyObservations(
    rules: DataQualityTableRule[],
    input: DataQualityQueryInput,
    anomalyPredicate: (rule: DataQualityTableRule) => string,
    samplePredicate: (rule: DataQualityTableRule) => string,
    labelPrefix: string,
    cutoffMs?: number,
  ): Promise<DataQualityObservation[]> {
    const observations: DataQualityObservation[] = [];
    for (const rule of rules) {
      const stats = await this.queryDailyStats(
        rule,
        input,
        anomalyPredicate(rule),
        cutoffMs === undefined ? undefined : new Date(cutoffMs),
      );
      const samples = await this.queryBadRows(
        rule,
        `${samplePredicate(rule)} AND ${qualified(rule.timeColumn)} >= $1::timestamptz AND ${qualified(rule.timeColumn)} < $2::timestamptz${cutoffMs === undefined ? '' : ` AND ${qualified(rule.timeColumn)} < $3::timestamptz`}`,
        cutoffMs === undefined
          ? [input.window.currentStart, input.window.currentEnd]
          : [
              input.window.currentStart,
              input.window.currentEnd,
              new Date(cutoffMs),
            ],
        input,
        `${labelPrefix}:${rule.table}`,
      );
      observations.push({
        scope: `${labelPrefix}:${rule.table}`,
        count: stats.currentCount,
        baselineCount: stats.baselineCount,
        totalCount: stats.currentTotal,
        baselineTotalCount: stats.baselineTotal,
        samples: samples.samples,
      });
    }
    return observations;
  }

  private async queryDailyStats(
    rule: DataQualityTableRule,
    input: DataQualityQueryInput,
    anomalyPredicate: string,
    cutoff?: Date,
  ): Promise<{
    currentCount: number;
    baselineCount: number;
    currentTotal: number;
    baselineTotal: number;
  }> {
    const time = qualified(rule.timeColumn);
    const dailyAnomaly =
      anomalyPredicate === 'TRUE'
        ? 'COUNT(*)'
        : `COUNT(*) FILTER (WHERE ${anomalyPredicate})`;
    const cutoffClause = cutoff ? ` AND ${time} < $5::timestamptz` : '';
    const params: unknown[] = [
      input.config.timezone,
      input.window.currentStart,
      input.window.baselineStart,
      input.window.currentEnd,
    ];
    if (cutoff) params.push(cutoff);

    const rows = await this.read(input, (query) =>
      query.query<DailyStatsRow>(
        `WITH calendar AS (
           SELECT generate_series(
             (($3::timestamptz AT TIME ZONE $1)::date),
             (($2::timestamptz AT TIME ZONE $1)::date),
             interval '1 day'
           )::date AS day
         ), daily AS (
           SELECT (${time} AT TIME ZONE $1)::date AS day,
                  ${dailyAnomaly} AS anomaly_count,
                  COUNT(*) AS total_count
           FROM ${tableName(rule.table)} AS t
           WHERE ${time} >= $3::timestamptz
             AND ${time} < $4::timestamptz${cutoffClause}
           GROUP BY 1
         ), combined AS (
           SELECT calendar.day,
                  COALESCE(daily.anomaly_count, 0) AS anomaly_count,
                  COALESCE(daily.total_count, 0) AS total_count
           FROM calendar
           LEFT JOIN daily ON daily.day = calendar.day
         )
         SELECT
           COALESCE(MAX(anomaly_count) FILTER (
             WHERE day = (($2::timestamptz AT TIME ZONE $1)::date)
           ), 0) AS current_count,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY anomaly_count)
             FILTER (WHERE day < (($2::timestamptz AT TIME ZONE $1)::date)), 0) AS baseline_count,
           COALESCE(MAX(total_count) FILTER (
             WHERE day = (($2::timestamptz AT TIME ZONE $1)::date)
           ), 0) AS current_total,
           COALESCE(SUM(total_count) FILTER (
             WHERE day < (($2::timestamptz AT TIME ZONE $1)::date)
           ), 0) AS baseline_total
         FROM combined`,
        params,
      ),
    );
    const row = rows[0];
    return {
      currentCount: toNumber(row?.current_count),
      baselineCount: toNumber(row?.baseline_count),
      currentTotal: toNumber(row?.current_total),
      baselineTotal: toNumber(row?.baseline_total),
    };
  }

  private async queryBadRows(
    rule: DataQualityTableRule,
    condition: string,
    parameters: unknown[],
    input: DataQualityQueryInput,
    label: string,
  ): Promise<{ count: number; samples: DataQualitySample[] }> {
    const limitPosition = parameters.length + 1;
    const rows = await this.read(input, (query) =>
      query.query<SampleRow>(
        `SELECT COUNT(*) OVER() AS anomaly_count,
                ${sampleColumns(rule)}
         FROM ${tableName(rule.table)} AS t
         WHERE ${condition}
         ORDER BY ${qualified(rule.timeColumn)} ASC NULLS FIRST
         LIMIT $${limitPosition}::int`,
        [...parameters, input.config.sampleLimit],
      ),
    );
    return {
      count: toNumber(rows[0]?.anomaly_count),
      samples: rows.map((row) => toSample(rule, row, label)),
    };
  }

  private read<T>(
    input: DataQualityQueryInput,
    operation: (query: DataQualityQueryPort) => Promise<T>,
  ): Promise<T> {
    return this.database.withReadOnly(
      input.config.statementTimeoutMs,
      operation,
    );
  }
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableName(value: string): string {
  return identifier(value);
}

function qualified(column: string): string {
  return `t.${identifier(column)}`;
}

function sampleColumns(rule: DataQualityTableRule): string {
  const columns = [`CAST(${qualified(rule.keyColumn)} AS text) AS sample_key`];
  if (rule.userColumn) {
    columns.push(`${qualified(rule.userColumn)} AS user_id`);
  }
  if (rule.externalUserColumn) {
    columns.push(`${qualified(rule.externalUserColumn)} AS external_user_id`);
  }
  if (rule.platformColumn) {
    columns.push(`${qualified(rule.platformColumn)} AS platform`);
  }
  return columns.join(', ');
}

function toSample(
  rule: DataQualityTableRule,
  row: SampleRow,
  label: string,
): DataQualitySample {
  return {
    table: rule.table,
    key: row.sample_key,
    userId: row.user_id,
    externalUserId: row.external_user_id,
    label: row.platform ? `platform=${row.platform};${label}` : label,
  };
}

function orphanPredicate(rule: DataQualityTableRule): string {
  const user = qualified(rule.userColumn!);
  return `${user} IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users AS parent WHERE parent.user_id = ${user}
  )`;
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
