/** One row of an account page — only the columns the report delivery needs. */
export interface ReportAccountRow {
  id: string;
  externalUserId: string;
  userId: number | null;
  platform: string;
}

/**
 * Bounded keyset reader over linked Discord accounts for the daily report
 * cron + delivery/retry flows. Implemented by the TypeORM repository in
 * `infrastructure/persistence/` — application code never touches the raw
 * entity (#428).
 */
export interface DiscordReportAccountPageReaderPort {
  findActiveAccountsPage(
    cursor: string | undefined,
    limit: number,
    /** forceSend ops override reads past the report consent gate (#596). */
    options?: { includeUnsubscribed?: boolean },
  ): Promise<ReportAccountRow[]>;
  /**
   * Single-link state lookup for delivery/retry: `null` when the external
   * user has no Discord link row at all.
   */
  findLinkStateByExternalUserId(externalUserId: string): Promise<{
    id: string;
    userId: number | null;
    linkState: string | null;
  } | null>;
  /** Marks the one-time opt-out footer as delivered on the link row (#596). */
  markOptOutNoticeSent?(id: string): Promise<void>;
}

export const DISCORD_REPORT_ACCOUNT_READER = Symbol(
  'DISCORD_REPORT_ACCOUNT_READER',
);
