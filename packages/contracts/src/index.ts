/**
 * Shared kernel contracts for cross-context use.
 *
 * Canonical owners: this package owns platform identity and the status/taxonomy
 * contracts consumed by more than one context (database entities, chat
 * packages, scheduler, study reminders, apps). Contexts that are the sole
 * consumer of a contract keep it local (e.g. chat quota reasons in
 * @wispace/chat-metering, study-reminder job status in
 * @wispace/study-reminder-shared, persistence-only states in @wispace/database).
 */

/** Platform discriminator used across all WISPACE bots. */
export type Platform = 'messenger' | 'discord' | 'zalo';

/** Canonical ownership state of a platform mapping. */
export type PlatformLinkState =
  | 'active'
  | 'confirmed-revoked'
  | 'temporarily-unknown'
  | 'locally-unlinked';

/** Report send job status. */
export type ReportSendJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

/**
 * Delivery outcome returned by outbound senders after calling the provider.
 * Persisted to close crash windows between provider ack and DB update (#291/#294).
 */
export type OutboundDeliveryOutcome =
  | 'sent'
  | 'ambiguous'
  | 'not_sent'
  | 'rate_limited';

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
