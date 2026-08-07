import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { hoursAgo, subtractMs } from '@wispace/date-utils';
import type { OpsHealthRepositoryPort } from './types';

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

const DEFAULT_DAILY_LIMIT = 15;

function readDailyLimitFromEnv(): () => number {
  return () => {
    const raw = process.env.CHAT_FREE_FORM_DAILY_LIMIT;
    return raw === undefined ? DEFAULT_DAILY_LIMIT : Number(raw);
  };
}

/**
 * TypeORM implementation of the ops health repository, parameterized by
 * platform. Daily limit defaults to `CHAT_FREE_FORM_DAILY_LIMIT` (15).
 */
@Injectable()
export class TypeormOpsHealthRepository implements OpsHealthRepositoryPort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly platform: string,
    private readonly dailyLimit: () => number = readDailyLimitFromEnv(),
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
    const since = hoursAgo(24);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM llm_safety_events WHERE platform = $1 AND created_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countDenyLogs24h(): Promise<number> {
    const since = hoursAgo(24);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'refunded' AND reserved_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckReserved(): Promise<number> {
    const stuckBefore = subtractMs(new Date(), 600_000);
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
    const since = hoursAgo(24);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 AND status = 'failed' AND updated_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckProcessing(): Promise<number> {
    const stuckBefore = subtractMs(new Date(), 300_000);
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
