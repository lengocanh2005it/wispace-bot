import type { Repository } from 'typeorm';
import type { ChatToolDailyUsageEntity } from '../entities/chat-tool-daily-usage.entity';
import type {
  WriteToolBudgetConsumeResult,
  WriteToolBudgetRepositoryPort,
} from './write-tool-budget.types';

export class WriteToolBudgetRepository implements WriteToolBudgetRepositoryPort {
  constructor(
    private readonly repo: Repository<ChatToolDailyUsageEntity>,
    private readonly platform: string,
  ) {}

  async getDailyCount(
    userId: number,
    usageDate: string,
    toolName: string,
  ): Promise<number> {
    const rows: Array<{ count: number }> = await this.repo.manager.query(
      `
        SELECT count FROM chat_tool_daily_usage
        WHERE platform = $1 AND user_id = $2 AND usage_date = $3::date AND tool_name = $4
      `,
      [this.platform, userId, usageDate, toolName],
    );
    return rows[0]?.count ?? 0;
  }

  async tryConsumeDaily(input: {
    externalUserId: string;
    userId: number;
    usageDate: string;
    toolName: string;
    dailyCap: number;
  }): Promise<WriteToolBudgetConsumeResult> {
    const rows: Array<{ count: number }> = await this.repo.manager.query(
      `
        INSERT INTO chat_tool_daily_usage
          (platform, external_user_id, user_id, usage_date, tool_name, count)
        VALUES ($1, $2, $3, $4::date, $5, 1)
        ON CONFLICT (platform, user_id, usage_date, tool_name)
        DO UPDATE SET
          count = chat_tool_daily_usage.count + 1,
          external_user_id = EXCLUDED.external_user_id,
          updated_at = now()
        WHERE chat_tool_daily_usage.count < $6
        RETURNING count
      `,
      [
        this.platform,
        input.externalUserId,
        input.userId,
        input.usageDate,
        input.toolName,
        input.dailyCap,
      ],
    );

    if (rows[0]) {
      return { ok: true, count: rows[0].count };
    }

    // Guard blocked the upsert — read the current count for the denial metric.
    const current = await this.getDailyCount(
      input.userId,
      input.usageDate,
      input.toolName,
    );
    return { ok: false, count: current };
  }

  async refundDaily(input: {
    userId: number;
    usageDate: string;
    toolName: string;
  }): Promise<void> {
    await this.repo.manager.query(
      `
        UPDATE chat_tool_daily_usage
        SET count = GREATEST(count - 1, 0), updated_at = now()
        WHERE platform = $1 AND user_id = $2 AND usage_date = $3::date AND tool_name = $4
      `,
      [this.platform, input.userId, input.usageDate, input.toolName],
    );
  }
}
