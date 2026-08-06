export interface ChatQuotaOpsSummary {
  usageDate: string;
  stuckReserved: number;
  stuckReservedMs: number;
  /** Set by OpsHealthService from the message log — absent from ChatQuotaOpsService.getSummary(). */
  denyLogs24h?: number;
  usersAtDailyLimit: number;
  dailyLimit: number;
  idempotencyByStatus: Record<string, number>;
  logGrepHints: string[];
}
