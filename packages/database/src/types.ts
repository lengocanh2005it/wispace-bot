/** Platform discriminator used across all WISPACE bots. */
export type Platform = 'messenger' | 'discord' | 'zalo';

/** Mapping status — only ACTIVE mappings receive notifications and are synced. */
export type MappingStatus = 'ACTIVE' | 'INACTIVE';

/** Canonical ownership state of a platform mapping. */
export type PlatformLinkState =
  | 'active'
  | 'confirmed-revoked'
  | 'temporarily-unknown'
  | 'locally-unlinked';

export type PlatformLinkObservation =
  | { kind: 'active'; userId: number; ownershipVersion?: string }
  | { kind: 'revoked'; reason: string; ownershipVersion?: string }
  | { kind: 'unknown'; reason: string };

export type PlatformLinkAuditEventType =
  | 'revoked'
  | 'unknown'
  | 'recovered'
  | 'stale_writer'
  | 'locally_unlinked';

/** Message log delivery status. */
export type MessageLogStatus = 'SENT' | 'FAILED';

/** Chat quota deny reasons. */
export type ChatQuotaDenyReason =
  | 'DAILY_LIMIT'
  | 'BURST_LIMIT'
  | 'NOT_LINKED'
  | 'IDEMPOTENCY_CONFLICT';

/** Chat idempotency row status. */
export type ChatIdempotencyStatus =
  | 'reserved'
  | 'delivered'
  | 'completed'
  | 'refunded';

/** Chat quota event types. */
export type ChatQuotaEventType =
  | 'CHAT_QUOTA_RESERVED'
  | 'CHAT_QUOTA_RELEASED'
  | 'CHAT_QUOTA_DENIED';

/** Chat quota release reasons. */
export type ChatQuotaReleaseReason = 'send_failed' | 'stuck_recover';

/** Report send job status. */
export type ReportSendJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

/** Scheduled report claim status. */
export type ScheduledReportClaimStatus =
  | 'claimed'
  | 'sent'
  | 'released'
  | 'cancelled';

/** Webhook dead letter status. */
export type WebhookDeadLetterStatus = 'pending' | 'replayed' | 'abandoned';

/** Durable inbound webhook inbox status — `abandoned` is terminal after bounded retries. */
export type WebhookInboundEventStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'abandoned';

/** Study reminder job status. */
export type StudyReminderJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

/** LLM feature tag for categorizing LLM calls. */
export type LlmFeature = 'FREE_FORM_CHAT' | 'STUDENT_REPORT' | 'STUDY_REMINDER';

/** Messenger messageType constants for message log categorization. */
export const MessageType = {
  STUDY_REMINDER: 'STUDY_REMINDER',
  REPORT: 'REPORT',
  FREE_FORM_CHAT_IN: 'FREE_FORM_CHAT_IN',
  FREE_FORM_CHAT_OUT: 'FREE_FORM_CHAT_OUT',
  FREE_FORM_CHAT_ERROR: 'FREE_FORM_CHAT_ERROR',
  CHAT_QUOTA_DENIED: 'CHAT_QUOTA_DENIED',
  CHAT_QUOTA_REMAINING_HINT: 'CHAT_QUOTA_REMAINING_HINT',
  PENDING_FEEDBACK: 'PENDING_FEEDBACK',
  WELCOME: 'WELCOME',
  GREETING: 'GREETING',
  SELF_INTRO: 'SELF_INTRO',
  MISSING_USER_REF: 'MISSING_USER_REF',
  CHAT_MISSING_MID: 'CHAT_MISSING_MID',
  UNSUPPORTED_MESSAGE_TYPE: 'UNSUPPORTED_MESSAGE_TYPE',
  MAPPING_RELINK_BLOCKED: 'MAPPING_RELINK_BLOCKED',
  MAPPING_USER_PSID_CONFLICT: 'MAPPING_USER_PSID_CONFLICT',
  MAPPING_USER_ID_UPDATED: 'MAPPING_USER_ID_UPDATED',
  STUDY_SESSION_REMINDER_EMPTY: 'STUDY_SESSION_REMINDER_EMPTY',
  STUDY_SESSION_REMINDER_PREVIEW: 'STUDY_SESSION_REMINDER_PREVIEW',
  SCHEDULED_LEARNING_REPORT: 'SCHEDULED_LEARNING_REPORT',
  LEARNING_PROGRESS: 'LEARNING_PROGRESS',
  LEARNING_PROGRESS_API_DEFERRED: 'LEARNING_PROGRESS_API_DEFERRED',
  SUBSCRIPTION_ALREADY_ACTIVE: 'SUBSCRIPTION_ALREADY_ACTIVE',
  SUBSCRIPTION_CONFIRMATION: 'SUBSCRIPTION_CONFIRMATION',
  RESCHEDULE_CANCELLED: 'RESCHEDULE_CANCELLED',
  RESCHEDULE_CONFIRMED: 'RESCHEDULE_CONFIRMED',
  RESCHEDULE_CONFIRM_FAILED: 'RESCHEDULE_CONFIRM_FAILED',
  MESSENGER_LINK_VERIFY_FAILED: 'MESSENGER_LINK_VERIFY_FAILED',
  CHAT_SESSIONS_GENERIC: 'CHAT_SESSIONS_GENERIC',
  CHAT_CALENDAR_GENERIC: 'CHAT_CALENDAR_GENERIC',
  CHAT_GOALS_GENERIC: 'CHAT_GOALS_GENERIC',
  CHAT_REMINDER_GENERIC: 'CHAT_REMINDER_GENERIC',
  CHAT_RESCHEDULE_GENERIC: 'CHAT_RESCHEDULE_GENERIC',
  CHAT_RESCHEDULE_CONFIRM: 'CHAT_RESCHEDULE_CONFIRM',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Calendar session time range filter. */
export type CalendarSessionTimeRange = 'upcoming' | 'past' | 'all';

/** Report delivery result reason. */
export type ReportDeliveryReason =
  | 'WINDOW_CLOSED'
  | 'DELIVERY_FAILED'
  | 'RETRYABLE'
  | 'NOT_LINKED';

/**
 * Delivery outcome returned by outbound senders after calling the provider.
 * Persisted to close crash windows between provider ack and DB update (#291/#294).
 */
export type OutboundDeliveryOutcome = 'sent' | 'ambiguous' | 'not_sent';
