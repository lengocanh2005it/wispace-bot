import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('chat_daily_usage')
@Index(
  'uq_chat_daily_usage_platform_external_date',
  ['platform', 'externalUserId', 'usageDate'],
  { unique: true },
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
