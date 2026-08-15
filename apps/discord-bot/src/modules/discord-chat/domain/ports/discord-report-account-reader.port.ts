/** One row of an account page — only the columns the report delivery needs. */
export interface ReportAccountRow {
  id: string;
  externalUserId: string;
  userId: number | null;
  platform: string;
}

/**
 * Bounded keyset reader over linked Discord accounts for the daily report
 * cron. Implemented by the TypeORM repository in `infrastructure/persistence/`
 * — application code never touches the raw entity.
 */
export interface DiscordReportAccountPageReaderPort {
  findActiveAccountsPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<ReportAccountRow[]>;
}

export const DISCORD_REPORT_ACCOUNT_READER = Symbol(
  'DISCORD_REPORT_ACCOUNT_READER',
);
