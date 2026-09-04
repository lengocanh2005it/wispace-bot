import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
import type { ScheduledReportClaimStatus } from '../types';

/** One scheduled report claim per learner/date/type across every platform. */
@Entity('learner_scheduled_report_claims')
@Index(
  'uq_learner_scheduled_report_claims_user_date_type',
  ['userId', 'reportDate', 'reportType'],
  { unique: true },
)
@Index('idx_learner_scheduled_report_claims_status_lease', [
  'status',
  'leaseExpiresAt',
])
@Index('idx_learner_scheduled_report_claims_created_at', ['createdAt'])
export class LearnerScheduledReportClaimEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ name: 'report_date', type: 'date' })
  reportDate!: string;

  @Column({
    name: 'report_type',
    type: 'varchar',
    length: 32,
    default: 'scheduled',
  })
  reportType!: string;

  @Column({ type: 'varchar', length: 16 })
  platform!: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId!: string;

  @Column({ type: 'varchar', length: 20, default: 'claimed' })
  status!: ScheduledReportClaimStatus;

  @Column({ name: 'lease_token', type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: 'delivery_record', type: 'text', nullable: true })
  deliveryRecord!: string | null;

  @Column({ name: 'delivery_key', type: 'text', nullable: true })
  deliveryKey!: string | null;

  @Column({
    name: 'delivery_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  deliveryStatus!: OutboundDeliveryOutcome | null;

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
