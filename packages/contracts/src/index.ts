/**
 * Shared kernel contracts for cross-context use.
 *
 * This package has zero imports by rule (`contracts-core-no-imports`), so every
 * declaration lives in this one module.
 *
 * Canonical owners: this package owns platform identity, the per-platform
 * storage layout that goes with it (ADR-0042), and the status/taxonomy
 * contracts consumed by more than one context (database entities, chat
 * packages, scheduler, study reminders, apps). Contexts that are the sole
 * consumer of a contract keep it local (e.g. chat quota reasons in
 * @wispace/chat-metering, study-reminder job status in
 * @wispace/study-reminder-shared, persistence-only states in @wispace/database).
 */

/**
 * The single declaration of the platform vocabulary; `Platform` is derived from
 * it so there is no second list to keep in step.
 *
 * `PLATFORM_STORAGE` states, per platform, which table and column hold that
 * platform's mapping and verify-intent rows (#1079). It is the only place a
 * platform name may become a storage fact.
 *
 * Table names live here rather than in `@wispace/database` because
 * `@wispace/study-reminder-shared` must not depend on the database package
 * (shared packages reach it only through adapter subpaths) yet must read the
 * same mapping table the erasure path reads. See ADR-0042.
 */
export const PLATFORMS = ['messenger', 'discord', 'zalo'] as const;

/** Platform discriminator used across all WISPACE bots. */
export type Platform = (typeof PLATFORMS)[number];

/**
 * Where one platform keeps its rows, and the shape differences between those
 * tables.
 *
 * The three platform mapping tables are siblings, not one primary table plus
 * two: they agree on `platform`, `external_user_id` and `link_state`, and
 * differ in whether they carry a status column.
 */
export interface PlatformStorage {
  /** Table holding this platform's externalUserId to WISPACE userId mapping. */
  readonly mappingTable: string;
  /** Table holding durable link-verify intents. */
  readonly verifyTable: string;
  /** Column on {@link PlatformStorage.verifyTable} carrying the platform external identifier. */
  readonly verifyIdColumn: string;
  /** Column carrying the ACTIVE/INACTIVE mapping status, or null when absent. */
  readonly statusColumn: 'status' | null;
}

/**
 * Literal values, not names derived by convention: a reader who must know the
 * naming rule to derive a value already has to know the rule, and the rule is
 * the part most easily forgotten. The ACTIVE/INACTIVE literals stay shared
 * because they are identical on every platform; only the column's presence
 * varies.
 */
export const PLATFORM_STORAGE = {
  messenger: {
    mappingTable: 'user_platform_mappings',
    verifyTable: 'messenger_link_verify_records',
    verifyIdColumn: 'psid',
    statusColumn: 'status',
  },
  discord: {
    mappingTable: 'discord_account_links',
    verifyTable: 'discord_link_verify_records',
    verifyIdColumn: 'discord_user_id',
    statusColumn: null,
  },
  zalo: {
    mappingTable: 'zalo_account_links',
    verifyTable: 'zalo_link_verify_records',
    verifyIdColumn: 'zalo_user_id',
    statusColumn: null,
  },
} as const satisfies Record<Platform, PlatformStorage>;

export const PRIVACY_CLEANUP_STORES = [
  'chat_history',
  'chat_queue',
  'clarification_state',
  'display_name_cache',
] as const;

export type PrivacyCleanupStore = (typeof PRIVACY_CLEANUP_STORES)[number];

export interface PrivacyExpectedMapping {
  exists: boolean;
  userId?: number;
  mappingGeneration?: string;
}

export interface PrivacyStateCleanup {
  platform?: Platform;
  applicableStores?: readonly PrivacyCleanupStore[];
  clearHistory?: (externalUserId: string) => Promise<void>;
  clearQueuedWork?: (externalUserId: string) => Promise<void>;
  clearClarification?: (externalUserId: string) => Promise<void>;
  clearUserCache?: (userId: number) => Promise<void>;
  onAttempt?: (
    store: PrivacyCleanupStore,
    outcome: 'success' | 'failure' | 'stale' | 'skipped',
  ) => void;
}

export interface PrivacyUnlinkResult {
  deleted: boolean;
  unlinked?: boolean;
  userId?: number;
  conflict?: boolean;
  status?: 'complete' | 'incomplete';
  cleanupId?: string;
  outstandingStores?: PrivacyCleanupStore[];
}

export interface PrivacyDeleteResult {
  deleted: boolean;
  userId?: number;
  conflict?: boolean;
  status: 'complete' | 'incomplete';
  cleanupId?: string;
  outstandingStores: PrivacyCleanupStore[];
}

export interface PrivacyDataPort {
  unlink(
    platform: Platform,
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyUnlinkResult>;
  delete(
    platform: Platform,
    externalUserId: string,
    cleanup?: PrivacyStateCleanup,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<PrivacyDeleteResult | boolean | void>;
  export(
    platform: Platform,
    externalUserId: string,
    expectedMapping?: PrivacyExpectedMapping,
  ): Promise<unknown>;
}

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

export const NOTIFICATION_PREFERENCE = Symbol('NOTIFICATION_PREFERENCE');

/**
 * Per-feature scheduled-notification consent.
 *
 * Defaults are asymmetric and must be preserved by any implementation: a NULL
 * report flag is opted OUT (reports are opt-in) while a NULL reminder flag is
 * opted IN (reminders are opt-out).
 */
export interface NotificationPreferencePort {
  setReportEnabled(userId: number, enabled: boolean): Promise<void>;
  setReminderEnabled(userId: number, enabled: boolean): Promise<void>;
  findReportOptedInUserIds(userIds: number[]): Promise<Set<number>>;
}

export const OUTBOUND_DELIVERY_JOURNAL = Symbol('OUTBOUND_DELIVERY_JOURNAL');

/**
 * Outbound durability journal (Discord and Zalo).
 *
 * The two operations deliberately keep their different failure semantics and
 * are never collapsed into one: `logDelivery` is best effort and never
 * throws, while `saveDeadLetter` resolves `false` when no durable recovery
 * record exists so the caller must treat the message as lost. Messenger
 * persists its audit rows through its own message-log repository port, so it
 * binds {@link OutboundDeadLetterPort} instead.
 */
export interface OutboundDeliveryJournalPort {
  logDelivery(input: {
    externalUserId: string;
    status: 'SENT' | 'FAILED';
    error?: string;
    messageType?: string;
  }): Promise<void>;
  saveDeadLetter(input: {
    externalUserId: string;
    rawPayload: unknown;
    errorMessage: string;
    direction?: 'inbound' | 'outbound';
    deliveryKey?: string;
  }): Promise<boolean>;
}

export const OUTBOUND_DEAD_LETTER = Symbol('OUTBOUND_DEAD_LETTER');

/** Dead-letter durability only; the audit log is owned elsewhere. */
export interface OutboundDeadLetterPort {
  /** Resolves `false` when no durable recovery record exists. */
  saveDeadLetter(input: {
    externalUserId: string;
    rawPayload: unknown;
    errorMessage: string;
    direction?: 'inbound' | 'outbound';
    deliveryKey?: string;
  }): Promise<boolean>;
}
