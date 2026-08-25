import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ZaloLinkVerifyRecordEntity } from '../../../infrastructure/database/entities/zalo-link-verify-record.entity';
import type {
  PendingZaloVerifyRecord,
  StaleZaloVerifyRecord,
  ZaloLinkVerifyRecordRepositoryPort,
} from '../domain/ports/zalo-link-verify-record.repository.port';

@Injectable()
export class TypeormZaloLinkVerifyRecordRepository implements ZaloLinkVerifyRecordRepositoryPort {
  constructor(
    @InjectRepository(ZaloLinkVerifyRecordEntity)
    private readonly repo: Repository<ZaloLinkVerifyRecordEntity>,
  ) {}

  async recordVerify(zaloUserId: string, userId: number): Promise<void> {
    await this.repo.upsert({ zaloUserId, userId, verifiedAt: new Date() }, [
      'zaloUserId',
    ]);
  }

  async consumeRecord(zaloUserId: string): Promise<void> {
    await this.repo.delete({ zaloUserId });
  }

  async listStaleRecords(
    olderThanMs: number,
  ): Promise<StaleZaloVerifyRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.repo.find({
      where: { verifiedAt: LessThan(cutoff) },
      order: { verifiedAt: 'ASC' },
      take: 100,
    });
    return rows.map((row) => ({
      zaloUserId: row.zaloUserId,
      userId: row.userId,
      verifiedAt: row.verifiedAt,
    }));
  }

  async findPending(
    zaloUserId: string,
  ): Promise<PendingZaloVerifyRecord | undefined> {
    const row = await this.repo.findOne({ where: { zaloUserId } });
    return row ? { userId: row.userId, verifiedAt: row.verifiedAt } : undefined;
  }
}
