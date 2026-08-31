export type WriteToolBudgetDeniedReason = 'daily' | 'per_message';

export interface WriteToolBudgetConsumeResult {
  ok: boolean;
  /** Count AFTER a successful consume, or the current count on denial. */
  count: number;
}

export interface WriteToolBudgetRepositoryPort {
  getDailyCount(
    userId: number,
    usageDate: string,
    toolName: string,
  ): Promise<number>;
  tryConsumeDaily(input: {
    externalUserId: string;
    userId: number;
    usageDate: string;
    toolName: string;
    dailyCap: number;
  }): Promise<WriteToolBudgetConsumeResult>;
  refundDaily(input: {
    userId: number;
    usageDate: string;
    toolName: string;
  }): Promise<void>;
}

export interface WriteToolBudgetSettings {
  enabled: boolean;
  timezone: string;
  /** tool name → daily cap. Tools absent here are not budgeted. */
  dailyCaps: Record<string, number>;
  /** tool name → per-message cap. */
  perMessageCaps: Record<string, number>;
  /** External ids that bypass the budget entirely. */
  whitelist: ReadonlySet<string>;
}
