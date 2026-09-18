import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Owner-aware daily FREE_FORM counters (#1177 / ADR-0027).
 *
 * A row is either a learner bucket row (`user_id` set) or an anonymous bucket
 * row (`user_id` NULL). Both may exist for the same `(platform,
 * external_user_id, usage_date)`: the anonymous row is unique per channel/date,
 * linked rows are unique per channel/date/owner. `user_id` is never rewritten,
 * so link churn cannot move usage between buckets.
 */
@Entity('chat_daily_usage')
@Index(
  'uq_chat_daily_usage_linked',
  ['platform', 'externalUserId', 'usageDate', 'userId'],
  { unique: true, where: '"user_id" IS NOT NULL' },
)
@Index(
  'uq_chat_daily_usage_anonymous',
  ['platform', 'externalUserId', 'usageDate'],
  { unique: true, where: '"user_id" IS NULL' },
)
@Index('idx_chat_daily_usage_user_date', ['userId', 'usageDate'], {
  where: '"user_id" IS NOT NULL',
})
export class ChatDailyUsageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'usage_date', type: 'date' })
  usageDate: string;

  @Column({ name: 'free_form_count', type: 'int', default: 0 })
  freeFormCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
