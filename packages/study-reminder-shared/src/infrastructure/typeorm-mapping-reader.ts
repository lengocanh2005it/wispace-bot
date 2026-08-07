import { Injectable } from '@nestjs/common';
import { Repository, type FindOptionsWhere } from 'typeorm';
import type { MappingReaderPort } from '../ports/mapping-reader.port';
import type { UserLink } from '../types/study-reminder.types';
import type { Platform } from '@wispace/database';

/** Minimum column shape shared by the per-app account-link entities. */
export interface AccountLinkRow {
  platform: string;
  externalUserId: string;
  userId: number;
}

/**
 * TypeORM implementation of `MappingReaderPort` — shared by Discord and Zalo
 * (replaces their near-identical per-app adapters). Parameterized over the
 * per-app account-link entity and the raw table name used by the bulk query.
 */
@Injectable()
export class TypeormMappingReader<
  Entity extends AccountLinkRow = AccountLinkRow,
> implements MappingReaderPort {
  constructor(
    private readonly repo: Repository<Entity>,
    private readonly tableName: string,
  ) {}

  async findActiveMappings(platform: string): Promise<UserLink[]> {
    const results = await this.repo.query<UserLink[]>(
      `SELECT external_user_id as "externalUserId", user_id as "userId", platform FROM ${this.tableName} WHERE platform = $1`,
      [platform],
    );
    return results;
  }

  async findActiveMappingByExternalUserId(
    platform: string,
    externalUserId: string,
  ): Promise<UserLink | null> {
    const link = await this.repo.findOne({
      where: { platform, externalUserId } as FindOptionsWhere<Entity>,
    });
    if (!link) return null;
    return {
      externalUserId: link.externalUserId,
      userId: link.userId,
      platform: link.platform as Platform,
    };
  }
}
