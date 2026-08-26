import { Column, CreateDateColumn, Entity, Index } from 'typeorm';

/**
 * Server-side OAuth state for Discord link CSRF protection (#264).
 * Mirrors zalo_oauth_states: random state → link token mapping,
 * single-use, 10min TTL enforced in app code.
 *
 * linkToken is encrypted at rest with AES-256-GCM (#399).
 */
@Entity('discord_oauth_states')
@Index('idx_discord_oauth_state_created', ['createdAt'])
export class DiscordOauthStateEntity {
  @Column({ name: 'state', type: 'varchar', length: 64, primary: true })
  state: string;

  @Column({ name: 'link_token', type: 'varchar', length: 512 })
  linkToken: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
