export const REPORT_CLAIM_REPOSITORY = Symbol('REPORT_CLAIM_REPOSITORY');

export interface ReportClaimRepositoryPort {
  hasSentScheduledReportToday(externalUserId: string): Promise<boolean>;
  hasAnyPlatformSentReportToday(
    userId: number,
    reportDate: string,
  ): Promise<boolean>;
  /** All userIds with a 'sent' claim for the date — lets crons skip per-user checks. */
  listUserIdsWithSentReportToday(reportDate: string): Promise<number[]>;
  tryClaimScheduledReport(params: {
    externalUserId: string;
    userId?: number;
    reportDate: string;
  }): Promise<boolean>;
  markScheduledReportClaimSent(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void>;
  releaseScheduledReportClaim(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void>;
  /**
   * Releases claims stuck in `claimed` past the given age (pod crash between
   * claim and mark-sent would otherwise burn the day's slot forever).
   * Messenger-only for now — Discord/Zalo release on every error path.
   */
  resetStaleScheduledReportClaims?(olderThan: Date): Promise<number>;
}
