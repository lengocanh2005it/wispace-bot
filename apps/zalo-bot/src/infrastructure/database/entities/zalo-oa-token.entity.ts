import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { oaTokenColumnTransformer } from './oa-token-crypto.transformer';

/** Maps the `zalo_oa_tokens` table — see migration in apps/messenger-bot. */
@Entity('zalo_oa_tokens')
export class ZaloOaTokenEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({
    name: 'access_token',
    type: 'text',
    transformer: oaTokenColumnTransformer,
  })
  accessToken: string;

  @Column({
    name: 'refresh_token',
    type: 'text',
    transformer: oaTokenColumnTransformer,
  })
  refreshToken: string;

  @Column({ name: 'access_token_expires_at', type: 'timestamptz' })
  accessTokenExpiresAt: Date;

  @Column({ name: 'refresh_token_expires_at', type: 'timestamptz' })
  refreshTokenExpiresAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'version', type: 'integer', default: 0 })
  version: number;
}
