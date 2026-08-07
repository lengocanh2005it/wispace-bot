import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform, ScheduledReportClaimStatus } from '../types';

@Entity('scheduled_report_claims')
@Index(
  'idx_scheduled_report_claims_platform_external_date',
  ['platform', 'externalUserId', 'reportDate'],
  { unique: true },
)
export class ScheduledReportClaimEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'report_date', type: 'date' })
  reportDate: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ type: 'varchar', length: 20, default: 'claimed' })
  status: ScheduledReportClaimStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
