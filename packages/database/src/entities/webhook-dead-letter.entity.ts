import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
import type { WebhookDeadLetterStatus } from '../types';

/** Direction of the dead-lettered operation — retry only replays outbound sends. */
export type WebhookDeadLetterDirection = 'inbound' | 'outbound';

/** Narrow row view used by bot dead-letter retry dispatchers. */
export interface WebhookDeadLetterEntry {
  id: number;
  externalUserId: string | null;
  rawPayload: unknown;
  errorMessage: string;
  retryCount: number;
  status: string;
  deliveryKey?: string | null;
  deliveryStatus?: OutboundDeliveryOutcome | null;
}

@Entity('webhook_dead_letters')
@Index('idx_webhook_dead_letter_platform_status_created', [
  'platform',
  'status',
  'createdAt',
])
@Index('idx_webhook_dead_letter_retry', [
  'platform',
  'status',
  'direction',
  'updatedAt',
])
export class WebhookDeadLetterEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 16, default: 'messenger' })
  platform!: Platform;

  @Column({
    name: 'external_user_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  externalUserId!: string | null;

  @Column({ name: 'message_mid', type: 'varchar', length: 255, nullable: true })
  messageMid!: string | null;

  @Column({
    name: 'direction',
    type: 'varchar',
    length: 10,
    default: 'inbound',
  })
  direction!: WebhookDeadLetterDirection;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload!: object;

  @Column({ name: 'error_message', type: 'text' })
  errorMessage!: string;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount!: number;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: WebhookDeadLetterStatus;

  @Column({ name: 'replayed_at', type: 'timestamptz', nullable: true })
  replayedAt!: Date | null;

  /**
   * Stable idempotency key for crash-safe replay — persisted before calling
   * the provider and reused on retry so the provider deduplicates (#291).
   */
  @Column({ name: 'delivery_key', type: 'text', nullable: true })
  deliveryKey!: string | null;

  /** Explicit delivery outcome: sent | ambiguous | not_sent (#291). */
  @Column({
    name: 'delivery_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  deliveryStatus!: OutboundDeliveryOutcome | null;

  /** Timestamp when the current processing attempt started (#291). */
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
