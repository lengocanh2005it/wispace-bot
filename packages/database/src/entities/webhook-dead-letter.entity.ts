import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform, WebhookDeadLetterStatus } from '../types';

/** Narrow row view used by bot dead-letter retry dispatchers. */
export interface WebhookDeadLetterEntry {
  id: number;
  externalUserId: string | null;
  rawPayload: unknown;
  errorMessage: string;
  retryCount: number;
  status: string;
}

@Entity('webhook_dead_letters')
@Index('idx_webhook_dead_letter_status_created', ['status', 'createdAt'])
export class WebhookDeadLetterEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform: Platform;

  @Column({
    name: 'external_user_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  externalUserId: string | null;

  @Column({ name: 'message_mid', type: 'varchar', length: 255, nullable: true })
  messageMid: string | null;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: object;

  @Column({ name: 'error_message', type: 'text' })
  errorMessage: string;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: WebhookDeadLetterStatus;

  @Column({ name: 'replayed_at', type: 'timestamptz', nullable: true })
  replayedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
