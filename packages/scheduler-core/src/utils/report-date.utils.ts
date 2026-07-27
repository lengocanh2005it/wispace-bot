/** ICT calendar date for scheduled report idempotency (R4). */
export function todayReportDate(
  timezone = 'Asia/Ho_Chi_Minh',
  now = new Date(),
): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
