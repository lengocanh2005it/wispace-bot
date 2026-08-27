import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { subHours, subMilliseconds } from 'date-fns';
import type {
  OpsHealthRepositoryPort,
  WebhookInboundOpsSummary,
  DeadLetterOpsSummary,
  ChatQuotaOpsSummary,
  StudyReminderOpsSummary,
} from './types';

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

interface WebhookInboundRow {
  pending_count: number;
  failed_count: number;
  stuck_processing_count: number;
  oldest_pending_age_seconds: number | null;
}

interface DeadLetterRow {
  pending_count: number;
  failed_count: number;
  oldest_pending_age_seconds: number | null;
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

  async isDatabaseReachable(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async getChatQuotaSummary(): Promise<ChatQuotaOpsSummary> {
    const [denyLogs24h, stuckReserved, usersAtDailyLimit] = await Promise.all([
      this.countDenyLogs24h(),
      this.countStuckReserved(),
      this.countUsersAtDailyLimit(),
    ]);
    return { denyLogs24h, stuckReserved, usersAtDailyLimit };
  }

  async getStudyReminderSummary(options?: {
    failedSinceHours?: number;
    stuckProcessingMinutes?: number;
  }): Promise<StudyReminderOpsSummary> {
    const failedHours = options?.failedSinceHours ?? 24;
    const stuckMinutes = options?.stuckProcessingMinutes ?? 5;
    const [countsByStatus, terminalFailedSince, stuckProcessing] =
      await Promise.all([
        this.getCountsByStatus(),
        this.countTerminalFailedSince(failedHours),
        this.countStuckProcessing(stuckMinutes),
      ]);
    return { countsByStatus, terminalFailedSince, stuckProcessing };
  }

  async getWebhookInboundSummary(): Promise<WebhookInboundOpsSummary> {
    const rows = await this.execQuery<WebhookInboundRow>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
         COUNT(*) FILTER (WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes')::int AS stuck_processing_count,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FILTER (WHERE status IN ('pending', 'failed', 'processing'))::int AS oldest_pending_age_seconds
       FROM webhook_inbound_events
       WHERE platform = $1`,
      [this.platform],
    );
    const row = rows[0];
    return {
      pendingCount: row?.pending_count ?? 0,
      failedCount: row?.failed_count ?? 0,
      stuckProcessingCount: row?.stuck_processing_count ?? 0,
      oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
    };
  }

  async getDeadLetterSummary(): Promise<DeadLetterOpsSummary> {
    const rows = await this.execQuery<DeadLetterRow>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) FILTER (WHERE status IN ('pending', 'failed'))::int AS oldest_pending_age_seconds
       FROM webhook_dead_letters
       WHERE platform = $1 AND direction = 'outbound'`,
      [this.platform],
    );
    const row = rows[0];
    return {
      outboundPendingCount: row?.pending_count ?? 0,
      outboundFailedCount: row?.failed_count ?? 0,
      oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
    };
  }

  async getLlmSafetyWarningsCount(since: Date): Promise<number> {
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM llm_safety_events WHERE platform = $1 AND created_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countDenyLogs24h(): Promise<number> {
    const since = subHours(new Date(), 24);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM chat_idempotency WHERE platform = $1 AND status = 'refunded' AND reserved_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckReserved(): Promise<number> {
    const stuckBefore = subMilliseconds(new Date(), 600_000);
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

  private async countTerminalFailedSince(hours: number): Promise<number> {
    const since = subHours(new Date(), hours);
    const rows = await this.execQuery<CountRow>(
      `SELECT COUNT(*)::int AS count FROM study_reminder_jobs WHERE platform = $1 AND status = 'failed' AND updated_at > $2`,
      [this.platform, since],
    );
    return rows[0]?.count ?? 0;
  }

  private async countStuckProcessing(minutes: number): Promise<number> {
    const stuckBefore = subMilliseconds(new Date(), minutes * 60_000);
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
