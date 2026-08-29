import { Injectable } from '@nestjs/common';
import { Repository, type FindOptionsWhere } from 'typeorm';
import type {
  MappingPage,
  MappingPageQuery,
  MappingReaderPort,
} from '../ports/mapping-reader.port';
import type { UserLink } from '../types/study-reminder.types';
import type { Platform } from '@wispace/database';
import type { PlatformLinkState } from '@wispace/database';

/** Minimum column shape shared by the per-app account-link entities. */
export interface AccountLinkRow {
  id: string;
  platform: string;
  externalUserId: string;
  userId: number;
  linkState?:
    | 'active'
    | 'confirmed-revoked'
    | 'temporarily-unknown'
    | 'locally-unlinked';
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

  async findActiveMappingsPage(
    platform: string,
    query: MappingPageQuery,
  ): Promise<MappingPage> {
    const results = await this.repo.query<AccountLinkRow[]>(
      `SELECT id, external_user_id as "externalUserId", user_id as "userId", platform
       FROM ${this.tableName}
       WHERE platform = $1 AND id > $2
         AND COALESCE(link_state, 'active') = 'active'
       ORDER BY id ASC
       LIMIT $3`,
      [platform, query.afterId ?? '0', query.limit],
    );

    const items: UserLink[] = results.map((row) => ({
      externalUserId: row.externalUserId,
      userId: row.userId,
      platform: row.platform as Platform,
    }));

    return {
      items,
      nextId:
        results.length > 0 ? String(results[results.length - 1].id) : undefined,
    };
  }

  async findActiveMappingByExternalUserId(
    platform: string,
    externalUserId: string,
  ): Promise<UserLink | null> {
    const link = await this.repo.findOne({
      where: { platform, externalUserId } as FindOptionsWhere<Entity>,
    });
    if (!link) return null;
    if (link.linkState && link.linkState !== 'active') return null;
    return {
      externalUserId: link.externalUserId,
      userId: link.userId,
      platform: link.platform as Platform,
    };
  }

  async getMappingState(
    _platform: string,
    externalUserId: string,
  ): Promise<PlatformLinkState | null> {
    const link = await this.repo.findOne({
      where: {
        platform: _platform,
        externalUserId,
      } as FindOptionsWhere<Entity>,
      select: { linkState: true } as never,
    });
    return link?.linkState ?? (link ? 'active' : null);
  }
}
