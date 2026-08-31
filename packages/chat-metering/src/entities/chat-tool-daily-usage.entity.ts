import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';

/**
 * Per-user, per-day counter for mutating LLM tool calls (#626). One row per
 * (platform, WISPACE user, calendar day in CHAT_USAGE_TIMEZONE, tool). The
 * unique index backs the atomic `INSERT … ON CONFLICT DO UPDATE … WHERE
 * count < cap` reserve. `external_user_id` is stored non-indexed for ops
 * debugging only — the budget is keyed on `user_id`.
 */
@Entity('chat_tool_daily_usage')
@Index(
  'uq_chat_tool_daily_usage',
  ['platform', 'userId', 'usageDate', 'toolName'],
  { unique: true },
)
export class ChatToolDailyUsageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'usage_date', type: 'date' })
  usageDate: string;

  @Column({ name: 'tool_name', type: 'varchar', length: 64 })
  toolName: string;

  @Column({ type: 'int', default: 0 })
  count: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
