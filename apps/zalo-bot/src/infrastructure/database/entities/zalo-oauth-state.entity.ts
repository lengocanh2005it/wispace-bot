import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Maps the `zalo_oauth_states` table — see migration in apps/messenger-bot. */
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
