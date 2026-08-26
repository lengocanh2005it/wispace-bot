import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  OutboundDeliveryOutcome,
  Platform,
  ScheduledReportClaimStatus,
} from '../types';

@Entity('scheduled_report_claims')
@Index(
  'idx_scheduled_report_claims_platform_external_date',
  ['platform', 'externalUserId', 'reportDate'],
  { unique: true },
)
@Index('idx_scheduled_report_claims_user_date_status', [
  'userId',
  'reportDate',
  'status',
])
@Index('idx_scheduled_report_claims_created_at', ['createdAt'])
export class ScheduledReportClaimEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform!: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId!: string;

  @Column({ name: 'report_date', type: 'date' })
  reportDate!: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId!: number | null;

  @Column({ type: 'varchar', length: 20, default: 'claimed' })
  status!: ScheduledReportClaimStatus;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  /**
   * Platform message_id after successful send. Non-null means the message
   * was delivered — on re-claim after crash, skip re-send (#181).
   */
  @Column({ name: 'delivery_record', type: 'text', nullable: true })
  deliveryRecord!: string | null;

  /**
   * Stable idempotency key for crash-safe delivery — persisted before
   * calling the provider, reused on retry to deduplicate (#294).
   */
  @Column({ name: 'delivery_key', type: 'text', nullable: true })
  deliveryKey!: string | null;

  /** Explicit delivery outcome: sent | ambiguous | not_sent (#294). */
  @Column({
    name: 'delivery_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  deliveryStatus!: OutboundDeliveryOutcome | null;

  /** Timestamp when the current processing attempt started (#294). */
  @Column({
    name: 'processing_started_at',
    type: 'timestamptz',
    nullable: true,
  })
  processingStartedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
