import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { WelcomeSource } from '@discord/modules/account-link/domain/ports/discord-welcome-record.repository.port';

/**
 * Single dedupe source for welcome DMs, keyed by Discord user id alone — an
 * unlinked user may never get a `discord_account_links` row, but the welcome
 * state must still exist (#231). Shared by the organic and the linked path
 * so a user welcomed organically is not re-welcomed at link time (#233).
 * See migration `AddDiscordWelcomeRecords*` in `packages/database`.
 */
@Entity('discord_welcome_records')
export class DiscordWelcomeRecordEntity {
  @PrimaryColumn({ name: 'discord_user_id', type: 'varchar', length: 64 })
  discordUserId: string;

  /** Last delivered welcome-DM timestamp — dedupes within the window. */
  @Column({ name: 'last_welcomed_at', type: 'timestamptz', nullable: true })
  lastWelcomedAt?: Date | null;

  /** Which flow delivered it — 'organic' | 'linked' (observability only). */
  @Column({ name: 'source', type: 'varchar', length: 16, nullable: true })
  source?: WelcomeSource | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
