import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform } from '@wispace/contracts';
import type { ChatIdempotencyStatus } from '../chat-rate-limit/types';

@Entity('chat_idempotency')
@Index('idx_chat_idempotency_platform_external_date', [
  'platform',
  'externalUserId',
  'usageDate',
])
@Index('idx_chat_idempotency_platform_status_reserved', [
  'platform',
  'status',
  'reservedAt',
])
@Index('idx_chat_idempotency_platform_external_reserved', [
  'platform',
  'externalUserId',
  'reservedAt',
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

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
