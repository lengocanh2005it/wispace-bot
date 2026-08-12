import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Platform, WebhookInboundEventStatus } from '../types';

/**
 * Durable inbox for authenticated inbound webhook events (Messenger/Zalo).
 * Events are persisted here BEFORE the webhook endpoint acknowledges them;
 * the unique (platform, event_id) constraint makes duplicate deliveries
 * idempotent, and failed events are retried by the inbound retry cron with
 * bounded backoff until `completed` or `abandoned` (terminal).
 */
@Entity('webhook_inbound_events')
@Index(
  'idx_webhook_inbound_events_platform_event_id',
  ['platform', 'eventId'],
  {
    unique: true,
  },
)
@Index('idx_webhook_inbound_events_status_due', [
  'platform',
  'status',
  'nextRetryAt',
])
export class WebhookInboundEventEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  platform: Platform;

  /** Stable per-delivery event id (Messenger mid, Zalo msg_id, ...). */
  @Column({ name: 'event_id', type: 'varchar', length: 255 })
  eventId: string;

  @Column({
    name: 'external_user_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  externalUserId: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 32, nullable: true })
  eventType: string | null;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: object;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: WebhookInboundEventStatus;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt: Date | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
