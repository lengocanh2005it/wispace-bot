import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ReportSendJobStatus = 'pending' | 'processing' | 'sent' | 'failed';

/** R5: outbox retry báo cáo cron khi Wispace 5xx — một job / (platform, external_user_id, exam_date). */
@Entity('report_send_jobs')
@Index(
  'idx_report_send_jobs_platform_external_exam_date',
  ['platform', 'externalUserId', 'examDate'],
  { unique: true },
)
@Index('idx_report_send_jobs_dispatch', ['status', 'nextRetryAt'])
export class ReportSendJobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'exam_date', type: 'date' })
  examDate: string;

  @Column({ name: 'first_attempt_date', type: 'date' })
  firstAttemptDate: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: ReportSendJobStatus;

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
