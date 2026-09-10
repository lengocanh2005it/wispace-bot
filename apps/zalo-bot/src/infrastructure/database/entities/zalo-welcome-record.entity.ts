import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { ZaloWelcomeSource } from '@zalo/modules/zalo-oauth/domain/ports/zalo-welcome-record.repository.port';

/** Shared dedupe state for linked/organic Zalo welcome messages. */
@Entity('zalo_welcome_records')
export class ZaloWelcomeRecordEntity {
  @PrimaryColumn({ name: 'zalo_user_id', type: 'varchar', length: 64 })
  zaloUserId: string;

  @Column({ name: 'last_welcomed_at', type: 'timestamptz', nullable: true })
  lastWelcomedAt?: Date | null;

  @Column({ name: 'source', type: 'varchar', length: 16, nullable: true })
  source?: ZaloWelcomeSource | null;

  @Column({ name: 'claim_expires_at', type: 'timestamptz', nullable: true })
  claimExpiresAt?: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
