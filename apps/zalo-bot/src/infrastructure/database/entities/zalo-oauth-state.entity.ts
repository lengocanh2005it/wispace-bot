import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Maps the `zalo_oauth_states` table — see migration in packages/database. */
/**
 * PKCE state for Zalo OAuth flow — single-use, 10min TTL.
 * codeVerifier and linkToken are encrypted at rest with AES-256-GCM (#399).
 */
@Entity('zalo_oauth_states')
@Index('idx_zalo_oauth_states_created_at', ['createdAt'])
export class ZaloOauthStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  state: string;

  @Column({ name: 'code_verifier', type: 'varchar', length: 512 })
  codeVerifier: string;

  @Column({ name: 'link_token', type: 'varchar', length: 512 })
  linkToken: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
