export const MESSENGER_REPORT_SENT_READER = Symbol(
  'MESSENGER_REPORT_SENT_READER',
);

/** Messenger compatibility guard for reports already logged as sent today. */
export interface MessengerReportSentReaderPort {
  hasSentScheduledReportToday(
    externalUserId: string,
    userId?: number,
  ): Promise<boolean>;
}
