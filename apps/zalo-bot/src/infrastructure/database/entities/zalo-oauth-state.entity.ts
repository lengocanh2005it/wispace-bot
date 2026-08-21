import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Maps the `zalo_oauth_states` table — see migration in apps/messenger-bot. */
/**
 * PKCE state for Zalo OAuth flow — single-use, 10min TTL.
 * codeVerifier and linkToken are stored as plaintext (#301 known limitation):
 * rows are short-lived and deleted on consume, so the risk window is minimal.
 * Encrypt at rest if the threat model requires it.
 */
@Entity('zalo_oauth_states')
@Index('idx_zalo_oauth_states_created_at', ['createdAt'])
export class ZaloOauthStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'code_verifier', type: 'varchar', length: 128 })
  codeVerifier: string;

  @Column({ name: 'link_token', type: 'varchar', length: 512 })
  linkToken: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
