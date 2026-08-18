import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Durable verify-intent outbox for the Zalo OAuth callback (#147, mirror of
 * the Discord flow #137). Inserted AFTER WISPACE consumes the single-use
 * link token and BEFORE the local mapping upsert; the zalo-link-reconcile
 * cron re-commits the mapping when the bot crashes in between, so WISPACE
 * "linked" never drifts from the bot mapping.
 */
@Entity('zalo_link_verify_records')
export class ZaloLinkVerifyRecordEntity {
  @PrimaryColumn({ name: 'zalo_user_id', type: 'varchar', length: 64 })
  zaloUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt: Date;
}
