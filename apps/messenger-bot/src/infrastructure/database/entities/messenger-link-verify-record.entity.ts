import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { NotificationCadence } from '@messenger/modules/messenger/domain/entities/messenger.types';
import type { MessengerLinkIntentState } from '@messenger/modules/messenger/domain/ports/messenger-link-verify-record.repository.port';

/**
 * Durable verify-intent outbox for the Messenger link flow (#384).
 * Inserted AFTER WISPACE consumes the single-use link token and BEFORE the
 * local mapping upsert; the reconciliation cron re-commits the mapping when
 * the bot crashes in between, so WISPACE "linked" never drifts from the bot
 * mapping.
 */
@Entity('messenger_link_verify_records')
export class MessengerLinkVerifyRecordEntity {
  @PrimaryColumn({ name: 'psid', type: 'varchar', length: 64 })
  psid: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'intent_generation', type: 'bigint', default: 1 })
  intentGeneration: string;

  @Column({
    name: 'ref_fingerprint',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  refFingerprint: string | null;

  @Column({ type: 'varchar', length: 100, default: 'IELTS' })
  topic: string;

  @Column({ type: 'varchar', length: 10, default: 'WEEKLY' })
  cadence: NotificationCadence;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: MessengerLinkIntentState;

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt: Date;
}
