import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { Platform, ChatIdempotencyStatus } from '@wispace/database';

@Entity('chat_idempotency')
@Index('idx_chat_idempotency_platform_external_date', [
  'platform',
  'externalUserId',
  'usageDate',
])
export class ChatIdempotencyEntity {
  @PrimaryColumn({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey: string;

  @PrimaryColumn({ type: 'varchar', length: 16, default: 'messenger' })
  platform: Platform;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId: number | null;

  @Column({ name: 'usage_date', type: 'date' })
  usageDate: string;

  @Column({
    name: 'reserved_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  reservedAt: Date;

  @Column({ type: 'varchar', length: 16, default: 'reserved' })
  status: ChatIdempotencyStatus;
}
