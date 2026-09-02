import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { PlatformLinkState } from '@wispace/contracts';

@Entity('discord_account_links')
@Index(
  'uq_discord_account_links_external_user_id',
  ['platform', 'externalUserId'],
  { unique: true },
)
@Index('uq_discord_account_links_user_id', ['platform', 'userId'], {
  unique: true,
})
export class DiscordAccountLinkEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 16, default: 'discord' })
  platform!: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 64 })
  externalUserId!: string;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @CreateDateColumn({ name: 'linked_at', type: 'timestamptz' })
  linkedAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;

  @Column({
    name: 'link_state',
    type: 'varchar',
    length: 24,
    default: 'active',
  })
  linkState!: PlatformLinkState;

  @Column({ name: 'mapping_generation', type: 'bigint', default: 1 })
  mappingGeneration!: string;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  @Column({ name: 'last_unknown_at', type: 'timestamptz', nullable: true })
  lastUnknownAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({
    name: 'revocation_reason',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  revocationReason!: string | null;

  @Column({
    name: 'upstream_ownership_version',
    type: 'varchar',
    length: 160,
    nullable: true,
  })
  upstreamOwnershipVersion!: string | null;

  @Column({ name: 'optin_prompt_sent_at', type: 'timestamptz', nullable: true })
  optinPromptSentAt!: Date | null;

  @Column({
    name: 'optout_notice_sent_at',
    type: 'timestamptz',
    nullable: true,
  })
  optoutNoticeSentAt!: Date | null;
}
