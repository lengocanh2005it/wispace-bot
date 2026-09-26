// DI tokens for the shared report-cron ports (#1088). The port interfaces
// live in `@wispace/scheduler-core/core` so Messenger and Discord share them.
export const CANONICAL_PLATFORM = Symbol('CANONICAL_PLATFORM');
export const REPORT_CRON_LEADER = Symbol('REPORT_CRON_LEADER');
export const REPORT_CRON_LOCK = Symbol('REPORT_CRON_LOCK');
export const REPORT_SCHEDULE = Symbol('REPORT_SCHEDULE');
export const WEB_ACTIVITY = Symbol('WEB_ACTIVITY');
export const REPORT_ORCHESTRATION = Symbol('REPORT_ORCHESTRATION');
export const ADVISORY_LOCK_PORT = Symbol('ADVISORY_LOCK_PORT');
