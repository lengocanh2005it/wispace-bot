import type { OutboundDeliveryOutcome } from '@wispace/contracts';

export const REPORT_CLAIM_REPOSITORY = Symbol('REPORT_CLAIM_REPOSITORY');

export interface ReportClaimRepositoryPort {
  hasSentScheduledReportToday(
    externalUserId: string,
    userId?: number,
  ): Promise<boolean>;
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
    deliveryKey?: string;
  }>;
  markScheduledReportClaimSent(
    params: {
      externalUserId: string;
      reportDate: string;
      userId?: number;
    },
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
    deliveryStatus?: OutboundDeliveryOutcome,
  ): Promise<boolean>;
  releaseScheduledReportClaim(
    params: {
      externalUserId: string;
      reportDate: string;
      userId?: number;
    },
    leaseToken: string,
  ): Promise<boolean>;
  /** Releases expired claims, including legacy rows without lease columns. */
  releaseExpiredScheduledReportClaims(
    now: Date,
    olderThan: Date,
  ): Promise<number>;
}
