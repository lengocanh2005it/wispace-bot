/**
 * The scheduled-report capability zalo-ops needs from zalo-chat.
 *
 * Narrow by design: ops triggers the daily wave and passes an operator
 * force-send override. Leader election, the advisory lock, batching and
 * per-learner claims stay inside zalo-chat behind the seam.
 */
export interface ZaloReportRunOptions {
  forceSend?: boolean;
}

export interface ZaloReportCronPort {
  sendDailyReports(opts?: ZaloReportRunOptions): Promise<void>;
}

export const ZALO_REPORT_CRON = Symbol('ZALO_REPORT_CRON');
