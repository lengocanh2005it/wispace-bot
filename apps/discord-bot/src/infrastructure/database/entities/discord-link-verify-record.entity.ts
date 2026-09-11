import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { LinkMappingObservation } from '@wispace/account-link-core/core';

/**
 * Durable verify-intent outbox for the Discord OAuth callback (#137 item 1).
 * Inserted AFTER WISPACE consumes the single-use link token and BEFORE the
 * local mapping upsert; the reconciliation cron re-commits the mapping when
 * the bot crashes in between, so WISPACE "linked" never drifts from the bot
 * mapping. See migration `AddDiscordLinkHardening1751029200019`.
 */
@Entity('discord_link_verify_records')
export class DiscordLinkVerifyRecordEntity {
  @PrimaryColumn({ name: 'discord_user_id', type: 'varchar', length: 64 })
  discordUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt: Date;

  @Column({ name: 'intent_generation', type: 'bigint' })
  intentGeneration: string;

  @Column({ name: 'observed_mapping_kind', type: 'varchar', length: 8 })
  observedMappingKind: LinkMappingObservation['kind'];

  @Column({
    name: 'observed_mapping_generation',
    type: 'bigint',
    nullable: true,
  })
  observedMappingGeneration: string | null;
}
