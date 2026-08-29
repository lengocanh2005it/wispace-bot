import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
import type { StudyReminderJobStatus } from '../types/study-reminder.types';

@Entity('study_reminder_jobs')
@Index(
  'idx_study_reminder_jobs_platform_external_session_key',
  ['platform', 'externalUserId', 'sessionKey'],
  { unique: true },
)
@Index('idx_study_reminder_jobs_dispatch', ['status', 'remindAt'])
@Index('idx_study_reminder_jobs_platform_status_remind', [
  'platform',
  'status',
  'remindAt',
])
@Index('idx_study_reminder_jobs_status_platform_lease', [
  'status',
  'platform',
  'leaseExpiresAt',
])
export class StudyReminderJobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  platform: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'session_key', type: 'varchar', length: 128 })
  sessionKey: string;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ name: 'remind_at', type: 'timestamptz' })
  remindAt: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  topic: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: StudyReminderJobStatus;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'max_retries', type: 'int', default: 3 })
  maxRetries: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  /** Lease owner token — set at claim, required for mark-sent/mark-failed. */
  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken: string | null;

  /** Claim deadline — recovery only reopens processing rows past this. */
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  /**
   * Platform message_id after successful send. Non-null means the message
   * was delivered — on re-claim after crash, skip re-send (#181).
   */
  @Column({ name: 'delivery_record', type: 'text', nullable: true })
  deliveryRecord: string | null;

  /**
   * Stable idempotency key for crash-safe delivery — persisted before
   * calling the provider, reused on retry to deduplicate (#294).
   */
  @Column({ name: 'delivery_key', type: 'text', nullable: true })
  deliveryKey: string | null;

  /** Explicit delivery outcome: sent | ambiguous | not_sent (#294). */
  @Column({
    name: 'delivery_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  deliveryStatus: OutboundDeliveryOutcome | null;

  /** Timestamp when the current processing attempt started (#294). */
  @Column({
    name: 'processing_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  processingStartedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
