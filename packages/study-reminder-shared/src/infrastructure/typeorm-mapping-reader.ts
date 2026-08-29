import { Injectable } from '@nestjs/common';
import { Repository, type FindOptionsWhere } from 'typeorm';
import type {
  MappingPage,
  MappingPageQuery,
  MappingReaderPort,
} from '../ports/mapping-reader.port';
import type { UserLink } from '../types/study-reminder.types';
import type { Platform, PlatformLinkState } from '@wispace/contracts';

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
 * SQL fragment: reminders are opt-out (#596) — a learner with no consent row
 * (or no explicit opt-out) still receives reminders.
 */
const REMINDER_OPTED_IN = `COALESCE(pref.reminder_enabled, true) = true`;

/** Shared LEFT JOIN against the per-user consent table (#596). */
const CONSENT_JOIN = `LEFT JOIN user_notification_preferences pref ON pref.user_id = m.user_id`;

/**
 * TypeORM implementation of `MappingReaderPort` — shared by Discord and Zalo
 * (replaces their near-identical per-app adapters). Parameterized over the
 * per-app account-link entity and the raw table name used by the bulk query.
 * Reminder reads filter on the per-user consent row (#596).
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
      `SELECT m.id, m.external_user_id as "externalUserId", m.user_id as "userId", m.platform
       FROM ${this.tableName} m
       ${CONSENT_JOIN}
       WHERE m.platform = $1 AND m.id > $2
         AND COALESCE(m.link_state, 'active') = 'active'
         AND ${REMINDER_OPTED_IN}
       ORDER BY m.id ASC
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
    const optedIn = await this.isReminderOptedIn(link.userId);
    if (!optedIn) return null;
    return {
      externalUserId: link.externalUserId,
      userId: link.userId,
      platform: link.platform as Platform,
    };
  }

  private async isReminderOptedIn(userId: number): Promise<boolean> {
    const rows = await this.repo.query<{ reminder_enabled: boolean | null }[]>(
      `SELECT reminder_enabled FROM user_notification_preferences WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.reminder_enabled !== false;
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
