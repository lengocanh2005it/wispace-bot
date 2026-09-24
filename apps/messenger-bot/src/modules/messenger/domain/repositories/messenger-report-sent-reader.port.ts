export const MESSENGER_REPORT_SENT_READER = Symbol(
  'MESSENGER_REPORT_SENT_READER',
);

/** Messenger compatibility guard for reports logged as sent on a report date. */
export interface MessengerReportSentReaderPort {
  hasSentScheduledReportOn(
    externalUserId: string,
    reportDate: string,
    userId?: number,
  ): Promise<boolean>;
}
