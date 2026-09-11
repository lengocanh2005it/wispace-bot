import type {
  MessageType,
  OutboundDeliveryOutcome,
  Platform,
  PlatformLinkState,
} from '@wispace/contracts';

/** Study reminder job status. */
export type StudyReminderJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

export type { OutboundDeliveryOutcome };

export interface StudyReminderJob {
  id: number;
  platform: Platform;
  externalUserId: string;
  userId?: number;
  /** Mapping ownership generation captured when the job was scheduled. */
  mappingGeneration?: string;
  sessionKey: string;
  scheduledAt: Date;
  remindAt: Date;
  topic?: string;
  status: StudyReminderJobStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastError?: string;
  sentAt?: Date;
  /** Lease owner token — set at claim, required for mark-sent/mark-failed. */
  leaseToken?: string;
  /** Claim deadline — recovery only reopens processing rows past this. */
  leaseExpiresAt?: Date;
  /**
   * Platform message_id after successful send. Non-null means the message
   * was delivered — on re-claim after crash, skip re-send (#181).
   */
  deliveryRecord?: string;
  /**
   * Stable idempotency key for crash-safe delivery — persisted before
   * calling the provider (#294).
   */
  deliveryKey?: string;
  /** Explicit delivery outcome: sent | ambiguous | not_sent | rate_limited. */
  deliveryStatus?: OutboundDeliveryOutcome;
  /** Timestamp when the current processing attempt started (#294). */
  processingStartedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertStudyReminderJobInput {
  platform: Platform;
  externalUserId: string;
  userId?: number;
  /** Present for new sync snapshots; omitted only by pre-fence callers. */
  mappingGeneration?: string;
  sessionKey: string;
  scheduledAt: Date;
  remindAt: Date;
  topic?: string;
  maxRetries: number;
}

export type GetSessionsFn = (
  externalUserId: string,
  userId?: number,
) => Promise<StudySessionRecord[]>;

export interface StudySessionRecord {
  calendarId: string;
  sessionKey: string;
  scheduledAt: Date;
  topic?: string;
}

export interface StudyReminderLlmInput {
  displayName: string;
  topic: string;
  scheduledTimeLabel: string;
  minutesUntilSession: number;
  targetScore?: string;
  task1Band?: string;
  task2Band?: string;
}

export interface StudyReminderLlmOutput {
  greeting: string;
  intro: string;
  scheduledTime: string;
  tasks: string[];
  motivation: string;
  signoff: string;
}

export interface UserLink {
  externalUserId: string;
  userId?: number;
  platform: Platform;
  /** Mapping ownership generation used to fence reminder jobs. */
  mappingGeneration?: string;
}

/**
 * Snapshot returned by mapping readers for the dispatch ownership fence.
 * Active snapshots always carry both the WISPACE owner and generation;
 * terminal/unknown snapshots deliberately carry no inferred owner.
 */
export type StudyReminderMappingState =
  | {
      state: 'active';
      userId: number;
      mappingGeneration: string;
    }
  | {
      state: Exclude<PlatformLinkState, 'active'>;
      userId?: number;
      mappingGeneration?: string;
    };

export interface SendMessageInput {
  externalUserId: string;
  text: string;
  messageType?: MessageType;
  userId?: number;
  /** Stable delivery key for crash-safe deduplication (#294). */
  deliveryKey?: string;
}

export interface StudyReminderSyncFailure {
  externalUserId: string;
  error: string;
}

/**
 * Result of a sync run. Counters are always present; `scope`/`userId`/
 * `linked`/`cancelledOtherPlatforms`/`failures` are populated by every run
 * (Messenger consumes the full shape — see scheduler.controller).
 */
export interface StudyReminderSyncResult {
  mappings: number;
  upserted: number;
  cancelled: number;
  skipped: number;
  failed: number;
  scope?: 'all' | 'user';
  userId?: number;
  linked?: boolean;
  cancelledOtherPlatforms?: number;
  failures?: StudyReminderSyncFailure[];
}
