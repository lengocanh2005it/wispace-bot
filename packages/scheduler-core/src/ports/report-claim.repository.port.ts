export const REPORT_CLAIM_REPOSITORY = Symbol('REPORT_CLAIM_REPOSITORY');

export interface ReportClaimRepositoryPort {
  hasSentScheduledReportToday(externalUserId: string): Promise<boolean>;
  hasAnyPlatformSentReportToday(
    userId: number,
    reportDate: string,
  ): Promise<boolean>;
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
}
