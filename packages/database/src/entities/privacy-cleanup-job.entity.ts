import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';
import type {
  PrivacyCleanupOperation,
  PrivacyCleanupJobStatus,
  PrivacyCleanupStore,
} from '../services/metering-and-operations/privacy-cleanup-job.service';

/** Durable, own-platform work item for state stores outside the DB transaction. */
@Entity('privacy_cleanup_jobs')
@Index('uq_privacy_cleanup_jobs_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
@Index('idx_privacy_cleanup_jobs_cleanup_id', ['cleanupId'])
@Index('idx_privacy_cleanup_jobs_due', [
  'platform',
  'status',
  'nextRetryAt',
  'leaseExpiresAt',
])
@Index('idx_privacy_cleanup_jobs_retention', [
  'status',
  'completedAt',
  'staleAt',
])
export class PrivacyCleanupJobEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'cleanup_id', type: 'varchar', length: 64 })
  cleanupId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 160 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 16 })
  operation!: PrivacyCleanupOperation;

  @Column({ type: 'varchar', length: 16 })
  platform!: Platform;

  /** Required to address the platform-owned Redis namespace on replay. */
  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId!: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId!: number | null;

  /** Ownership generation captured by the erasure transaction. */
  @Column({ name: 'mapping_generation', type: 'varchar', length: 64 })
  mappingGeneration!: string;

  @Column({ type: 'varchar', length: 32 })
  store!: PrivacyCleanupStore;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: PrivacyCleanupJobStatus;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({
    name: 'next_retry_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  nextRetryAt!: Date;

  @Column({ name: 'lease_token', type: 'varchar', length: 64, nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', length: 160, nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'stale_at', type: 'timestamptz', nullable: true })
  staleAt!: Date | null;
}
