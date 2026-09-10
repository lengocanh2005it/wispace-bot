import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { ZaloOaTokenEntity } from '../../../../infrastructure/database/entities/zalo-oa-token.entity';
import type {
  ZaloOaTokenPair,
  ZaloOaTokenSnapshot,
  ZaloOaTokenStorePort,
} from '../../application/ports/zalo-oa-token-store.port';

function toSnapshot(row: ZaloOaTokenEntity): ZaloOaTokenSnapshot {
  return {
    id: row.id,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** TypeORM adapter for the encrypted, single-row OA token store (#429). */
@Injectable()
export class TypeormZaloOaTokenStoreAdapter implements ZaloOaTokenStorePort {
  constructor(
    @InjectRepository(ZaloOaTokenEntity)
    private readonly repo: Repository<ZaloOaTokenEntity>,
  ) {}

  async readCurrent(): Promise<ZaloOaTokenSnapshot | undefined> {
    const row = await this.repo.findOne({ where: {}, order: { id: 'DESC' } });
    return row ? toSnapshot(row) : undefined;
  }

  refreshWithLock(
    refresh: (
      current: ZaloOaTokenSnapshot,
    ) => Promise<ZaloOaTokenPair | undefined>,
  ): Promise<ZaloOaTokenSnapshot | undefined> {
    return this.repo.manager.transaction(async (em) => {
      const row = await this.findLocked(em);
      if (!row) return undefined;

      const current = toSnapshot(row);
      const next = await refresh(current);
      if (!next) return current;

      const now = new Date();
      await em.update(
        ZaloOaTokenEntity,
        { id: row.id, version: row.version },
        {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          accessTokenExpiresAt: next.accessTokenExpiresAt,
          refreshTokenExpiresAt: next.refreshTokenExpiresAt,
          updatedAt: now,
          version: row.version + 1,
        },
      );

      return {
        ...current,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        accessTokenExpiresAt: next.accessTokenExpiresAt,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt,
        updatedAt: now,
        version: row.version + 1,
      };
    });
  }

  private findLocked(em: EntityManager): Promise<ZaloOaTokenEntity | null> {
    return em.findOne(ZaloOaTokenEntity, {
      where: {},
      order: { id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
  }
}
