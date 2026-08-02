import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { OpsHealthRepositoryPort } from '@wispace/ops-health';

const PLATFORM = 'zalo';

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

@Injectable()
export class ZaloOpsHealthRepository implements OpsHealthRepositoryPort {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
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
      [PLATFORM, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countDenyLogs24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'refunded' AND reserved_at > $2`,
      [PLATFORM, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckReserved(): Promise<number> {
    const stuckBefore = new Date(Date.now() - 600_000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'reserved' AND reserved_at < $2`,
      [PLATFORM, stuckBefore],
    );
    return rows[0]?.count ?? 0;
  }

  private async countUsersAtDailyLimit(): Promise<number> {
    const today = new Date().toISOString().split('T')[0];
    const limit = Number(
      this.configService.get<string>('CHAT_FREE_FORM_DAILY_LIMIT') ?? 15,
    );
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_daily_usage WHERE platform = $1 AND usage_date = $2::date AND free_form_count >= $3`,
      [PLATFORM, today, limit],
    );
    return rows[0]?.count ?? 0;
  }

  private async getCountsByStatus(): Promise<Record<string, number>> {
    const rows = await this.execQuery<StatusCountRow>(
      `SELECT status, COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 GROUP BY status`,
      [PLATFORM],
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
      [PLATFORM, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckProcessing(): Promise<number> {
    const stuckBefore = new Date(Date.now() - 300_000);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 AND status = 'processing' AND updated_at < $2`,
      [PLATFORM, stuckBefore],
    );
    return rows[0]?.count ?? 0;
  }

  private async execQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await this.dataSource.query(sql, params);

    return result as T[];
  }
}
