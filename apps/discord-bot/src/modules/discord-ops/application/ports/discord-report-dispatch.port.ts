/**
 * On-demand trigger for the daily Discord report wave, as the ops surface needs
 * it. `discord-ops` must not reach into `discord-chat`'s concrete cron service,
 * so the composition root binds that service to the token below.
 */
export interface DiscordReportRunSummary {
  total: number;
  sent: number;
  skipped: number;
  claimSkipped: number;
  failed: number;
  failures: Array<{ externalUserId: string; error: string }>;
}

export interface DiscordReportDispatchPort {
  /**
   * Runs the scheduled report wave now. `forceSend` bypasses the consent and
   * exam-window gates for an operator override; it never bypasses the
   * already-sent-today dedupe.
   */
  sendScheduledReports(opts?: {
    forceSend?: boolean;
    externalUserId?: string;
  }): Promise<DiscordReportRunSummary>;
}

export const DISCORD_REPORT_DISPATCH = Symbol('DISCORD_REPORT_DISPATCH');
