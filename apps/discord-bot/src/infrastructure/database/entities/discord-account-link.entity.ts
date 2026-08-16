import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Maps the `discord_account_links` table — see migration in apps/messenger-bot. */
@Entity('discord_account_links')
@Index(
  'uq_discord_account_links_external_user_id',
  ['platform', 'externalUserId'],
  {
    unique: true,
  },
)
@Index('uq_discord_account_links_user_id', ['platform', 'userId'], {
  unique: true,
})
export class DiscordAccountLinkEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 16, default: 'discord' })
  platform: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId: string;

  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @CreateDateColumn({ name: 'linked_at', type: 'timestamptz' })
  linkedAt: Date;
}
