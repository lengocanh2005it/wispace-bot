import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { OpsHealthRepositoryPort } from './types';

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

/**
 * TypeORM implementation of the ops health repository, parameterized by
 * platform and a daily-limit resolver (Discord hardcodes 15; Zalo reads
 * `CHAT_FREE_FORM_DAILY_LIMIT`).
 */
@Injectable()
export class TypeormOpsHealthRepository implements OpsHealthRepositoryPort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly platform: string,
    private readonly dailyLimit: () => number,
  ) {}

  async getChatQuotaSummary(): Promise<Record<string, unknown>> {
    const [denyLogs24h, stuckReserved, usersAtDailyLimit] = await Promise.all([
      this.countDenyLogs24h(),
      this.countStuckReserved(),
      this.countUsersAtDailyLimit(),
    ]);
    return { denyLogs24h, stuckReserved, usersAtDailyLimit };
  }

  async getStudyReminderSummary(): Promise<Record<string, unknown>> {
    const countsByStatus = await this.getCountsByStatus();
    const terminalFailedSince = await this.countTerminalFailedSince();
    const stuckProcessing = await this.countStuckProcessing();
    return { countsByStatus, terminalFailedSince, stuckProcessing };
  }

  async getLlmSafetyWarningsCount(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM llm_safety_events WHERE platform = $1 AND created_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countDenyLogs24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'refunded' AND reserved_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckReserved(): Promise<number> {
    const stuckBefore = new Date(Date.now() - 600_000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'reserved' AND reserved_at < $2`,
      [this.platform, stuckBefore],
    );
    return rows[0]?.count ?? 0;
  }

  private async countUsersAtDailyLimit(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const limit = this.dailyLimit();
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_daily_usage WHERE platform = $1 AND usage_date = $2::date AND free_form_count >= $3`,
      [this.platform, today, limit],
    );
    return rows[0]?.count ?? 0;
  }

  private async getCountsByStatus(): Promise<Record<string, number>> {
    const rows = await this.execQuery<StatusCountRow>(
      `SELECT status, COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 GROUP BY status`,
      [this.platform],
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  private async countTerminalFailedSince(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 AND status = 'failed' AND updated_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckProcessing(): Promise<number> {
    const stuckBefore = new Date(Date.now() - 300_000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 AND status = 'processing' AND updated_at < $2`,
      [this.platform, stuckBefore],
    );
    return rows[0]?.count ?? 0;
  }

  private async execQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.dataSource.query(sql, params);

    return result as T[];
  }
}
