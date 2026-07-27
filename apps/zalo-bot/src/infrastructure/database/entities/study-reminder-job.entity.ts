import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type StudyReminderJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

@Entity('study_reminder_jobs')
@Index(
  'idx_study_reminder_jobs_platform_external_session_key',
  ['platform', 'externalUserId', 'sessionKey'],
  { unique: true },
)
@Index('idx_study_reminder_jobs_dispatch', ['status', 'remindAt'])
export class StudyReminderJobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: string;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
