import { Column, Entity, PrimaryColumn } from 'typeorm';

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

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt: Date;
}
