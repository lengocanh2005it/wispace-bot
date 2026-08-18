export const REPORT_CLAIM_REPOSITORY = Symbol('REPORT_CLAIM_REPOSITORY');

export interface ReportClaimRepositoryPort {
  hasSentScheduledReportToday(externalUserId: string): Promise<boolean>;
  hasAnyPlatformSentReportToday(
    userId: number,
    reportDate: string,
  ): Promise<boolean>;
  /** All userIds with a 'sent' claim for the date — lets crons skip per-user checks. */
  listUserIdsWithSentReportToday(reportDate: string): Promise<number[]>;
  tryClaimScheduledReport(
    params: {
      externalUserId: string;
      userId?: number;
      reportDate: string;
    },
    leaseMs: number,
  ): Promise<{
    claimed: boolean;
    leaseToken?: string;
    deliveryRecord?: string;
  }>;
  markScheduledReportClaimSent(
    params: {
      externalUserId: string;
      reportDate: string;
    },
    leaseToken: string,
    deliveryRecord?: string,
  ): Promise<boolean>;
  releaseScheduledReportClaim(
    params: {
      externalUserId: string;
      reportDate: string;
    },
    leaseToken: string,
  ): Promise<boolean>;
  /** Releases expired claims, including legacy rows without lease columns. */
  releaseExpiredScheduledReportClaims(
    now: Date,
    olderThan: Date,
  ): Promise<number>;
}
