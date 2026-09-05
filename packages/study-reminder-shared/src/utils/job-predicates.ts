/**
 * SQL fragments shared by the reminder repository and operator views.
 * Keep delivery eligibility in one place so a new terminal outcome cannot
 * accidentally re-enter one query path but not another.
 */

function column(alias: string, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

export function studyReminderDispatchPredicateSql(alias = ''): string {
  const status = column(alias, 'status');
  const retryCount = column(alias, 'retry_count');
  const maxRetries = column(alias, 'max_retries');
  const deliveryStatus = column(alias, 'delivery_status');
  const deliveryRecord = column(alias, 'delivery_record');

  return `(${status} = 'pending' OR (${status} = 'failed' AND ${retryCount} < ${maxRetries}))
    AND (${deliveryStatus} IS NULL OR (${deliveryStatus} = 'not_sent' AND ${retryCount} < ${maxRetries}))
    AND ${deliveryRecord} IS NULL`;
}

export function studyReminderTerminalFailurePredicateSql(alias = ''): string {
  const status = column(alias, 'status');
  const retryCount = column(alias, 'retry_count');
  const maxRetries = column(alias, 'max_retries');
  const deliveryStatus = column(alias, 'delivery_status');

  return `((${status} = 'failed' AND ${retryCount} >= ${maxRetries})
    OR (${status} IN ('pending', 'failed') AND ${deliveryStatus} IN ('ambiguous', 'rate_limited')))`;
}

export function studyReminderTerminalRetentionPredicateSql(alias = ''): string {
  const status = column(alias, 'status');
  const retryCount = column(alias, 'retry_count');
  const maxRetries = column(alias, 'max_retries');
  const deliveryStatus = column(alias, 'delivery_status');

  return `((${status} IN ('cancelled', 'failed') AND ${retryCount} >= ${maxRetries})
    OR (${status} IN ('pending', 'failed') AND ${deliveryStatus} IN ('ambiguous', 'rate_limited')))`;
}
