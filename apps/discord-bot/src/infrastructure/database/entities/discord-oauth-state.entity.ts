import { Column, CreateDateColumn, Entity, Index } from 'typeorm';

/**
 * Server-side OAuth state for Discord link CSRF protection (#264).
 * Mirrors zalo_oauth_states: random state → link token mapping,
 * single-use, 10min TTL enforced in app code.
 *
 * linkToken is stored as plaintext (#301 known limitation):
 * rows are short-lived and deleted on consume, so the risk window is minimal.
 * Encrypt at rest if the threat model requires it.
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
