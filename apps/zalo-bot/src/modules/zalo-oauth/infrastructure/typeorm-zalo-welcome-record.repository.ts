import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZaloWelcomeRecordEntity } from '../../../infrastructure/database/entities/zalo-welcome-record.entity';
import type {
  ZaloWelcomeRecordRepositoryPort,
  ZaloWelcomeSource,
} from '../domain/ports/zalo-welcome-record.repository.port';

@Injectable()
export class TypeormZaloWelcomeRecordRepository implements ZaloWelcomeRecordRepositoryPort {
  constructor(
    @InjectRepository(ZaloWelcomeRecordEntity)
    private readonly repo: Repository<ZaloWelcomeRecordEntity>,
  ) {}

  async tryClaimWelcome(
    zaloUserId: string,
    windowMs: number,
    leaseMs: number,
  ): Promise<boolean> {
    const rows = await this.repo.manager.query<Array<{ zalo_user_id: string }>>(
      `
        INSERT INTO zalo_welcome_records (zalo_user_id, claim_expires_at)
        VALUES ($1, now() + $2 * interval '1 millisecond')
        ON CONFLICT (zalo_user_id)
        DO UPDATE SET claim_expires_at = EXCLUDED.claim_expires_at
        WHERE zalo_welcome_records.last_welcomed_at IS NULL
           OR zalo_welcome_records.last_welcomed_at <
              now() - $3 * interval '1 millisecond'
           OR zalo_welcome_records.claim_expires_at < now()
        RETURNING zalo_user_id
      `,
      [zaloUserId, leaseMs, windowMs],
    );
    return rows.length > 0;
  }

  async markWelcomed(
    zaloUserId: string,
    source: ZaloWelcomeSource,
  ): Promise<void> {
    await this.repo.upsert(
      {
        zaloUserId,
        lastWelcomedAt: new Date(),
        source,
        claimExpiresAt: null,
      },
      ['zaloUserId'],
    );
  }
}
