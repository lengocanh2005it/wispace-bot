/**
 * Cross-cutting service — no context in `CONTEXT-MAP.md` owns it.
 * Consumers: each app's `database.module`, its study-reminder module, and its
 * scheduled-report module. Stays in `packages/database` until an owning package
 * can host it; see `docs/architecture-boundaries.md` for the folder convention.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PLATFORMS } from '@wispace/contracts';
import type { Platform } from '@wispace/contracts';
import { UserNotificationPreferenceEntity } from '../../entities/user-notification-preference.entity';

export const DEFAULT_PLATFORM_PRIORITY: Platform[] = [
  'zalo',
  'discord',
  'messenger',
];

type CanonicalPlatformRow = {
  user_id: number | string;
  preferred_platform: string | null;
  active_platforms: string[] | null;
};

type UserPlatformState = {
  activePlatforms: Platform[];
  preferredPlatform: Platform | null;
};

/**
 * Pure deterministic resolver:
 * 1. If preferredPlatform is present and currently active -> returns preferredPlatform.
 * 2. Otherwise -> returns the highest priority active platform (zalo > discord > messenger).
 */
export function resolveCanonicalPlatform(
  activePlatforms: Platform[],
  preferredPlatform?: Platform | null,
): Platform | undefined {
  if (activePlatforms.length === 0) {
    return undefined;
  }
  if (preferredPlatform && activePlatforms.includes(preferredPlatform)) {
    return preferredPlatform;
  }
  return DEFAULT_PLATFORM_PRIORITY.find((p) => activePlatforms.includes(p));
}

/**
 * Shared service to query active multi-platform links for a WISPACE userId,
 * load learner notification preferences, and resolve the canonical notification platform.
 */
@Injectable()
export class CanonicalPlatformService {
  private readonly logger = new Logger(CanonicalPlatformService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(UserNotificationPreferenceEntity)
    private readonly preferenceRepo: Repository<UserNotificationPreferenceEntity>,
  ) {}

  /**
   * Get active linked platforms and the preferred platform for a given WISPACE userId.
   */
  async getActivePlatformsForUser(userId: number): Promise<{
    activePlatforms: Platform[];
    preferredPlatform: Platform | null;
  }> {
    return (await this.loadUserPlatformStates([userId])).get(userId)!;
  }

  /**
   * Resolve canonical delivery platforms for a bounded batch of WISPACE users.
   * The report crons call this once per page to avoid one query per mapping.
   */
  async getCanonicalPlatformsForUsers(
    userIds: readonly number[],
  ): Promise<Map<number, Platform | undefined>> {
    const states = await this.loadUserPlatformStates(userIds);
    return new Map(
      [...states].map(([userId, state]) => [
        userId,
        resolveCanonicalPlatform(
          state.activePlatforms,
          state.preferredPlatform,
        ),
      ]),
    );
  }

  /**
   * Resolve the canonical delivery platform for a WISPACE userId.
   * Returns undefined if the user has no active links on any platform.
   */
  async getCanonicalPlatformForUser(
    userId: number,
  ): Promise<Platform | undefined> {
    return (await this.getCanonicalPlatformsForUsers([userId])).get(userId);
  }

  /**
   * Check whether currentPlatform is the resolved canonical platform for the user.
   * Returns { isCanonical: false, canonicalPlatform } if another platform is canonical.
   */
  async isCanonicalForUser(
    userId: number,
    currentPlatform: Platform,
  ): Promise<{ isCanonical: boolean; canonicalPlatform?: Platform }> {
    const canonical = await this.getCanonicalPlatformForUser(userId);
    if (canonical && canonical !== currentPlatform) {
      return { isCanonical: false, canonicalPlatform: canonical };
    }
    return { isCanonical: true, canonicalPlatform: canonical };
  }

  /**
   * Set or clear the learner's preferred notification platform.
   */
  async setPreferredPlatform(
    userId: number,
    preferredPlatform: Platform | null,
  ): Promise<void> {
    await this.preferenceRepo.upsert(
      {
        userId,
        preferredPlatform,
        updatedAt: new Date(),
      },
      ['userId'],
    );
    this.logger.log(
      `Updated preferred notification platform for userId=${userId} to ${preferredPlatform ?? 'none'}`,
    );
  }

  /**
   * Get the stored preferred platform for a given WISPACE userId.
   */
  async getPreferredPlatform(userId: number): Promise<Platform | null> {
    const pref = await this.preferenceRepo.findOne({ where: { userId } });
    return pref?.preferredPlatform ?? null;
  }

  private async loadUserPlatformStates(
    userIds: readonly number[],
  ): Promise<Map<number, UserPlatformState>> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) return new Map();

    const rows = (await this.dataSource.query(
      `
      WITH requested_users AS (
        SELECT DISTINCT user_id
        FROM unnest($1::int[]) AS input(user_id)
      ), active_links AS (
        SELECT zal.user_id, 'zalo'::text AS platform
        FROM zalo_account_links zal
        WHERE zal.user_id = ANY($1::int[])
          AND COALESCE(zal.link_state, 'active') = 'active'
          AND NULLIF(zal.external_user_id, '') IS NOT NULL
        UNION ALL
        SELECT dal.user_id, 'discord'::text AS platform
        FROM discord_account_links dal
        WHERE dal.user_id = ANY($1::int[])
          AND COALESCE(dal.link_state, 'active') = 'active'
          AND NULLIF(dal.external_user_id, '') IS NOT NULL
        UNION ALL
        SELECT upm.user_id, 'messenger'::text AS platform
        FROM user_platform_mappings upm
        WHERE upm.user_id = ANY($1::int[])
          AND upm.status = 'ACTIVE'
          AND COALESCE(upm.link_state, 'active') = 'active'
          AND NULLIF(upm.external_user_id, '') IS NOT NULL
      )
      SELECT requested.user_id,
             pref.preferred_platform,
             COALESCE(
               ARRAY_AGG(active.platform) FILTER (WHERE active.platform IS NOT NULL),
               ARRAY[]::text[]
             ) AS active_platforms
      FROM requested_users requested
      LEFT JOIN user_notification_preferences pref
        ON pref.user_id = requested.user_id
      LEFT JOIN active_links active
        ON active.user_id = requested.user_id
      GROUP BY requested.user_id, pref.preferred_platform
      `,
      [uniqueUserIds],
    )) as CanonicalPlatformRow[];

    const states = new Map<number, UserPlatformState>();
    for (const row of rows) {
      const userId = Number(row.user_id);
      if (!uniqueUserIds.includes(userId) || states.has(userId)) {
        throw new Error(
          'Canonical platform batch lookup returned invalid results',
        );
      }

      const activePlatforms = this.parsePlatforms(row.active_platforms);
      const preferredPlatform = this.parsePlatform(row.preferred_platform);
      states.set(userId, { activePlatforms, preferredPlatform });
    }

    if (states.size !== uniqueUserIds.length) {
      throw new Error(
        'Canonical platform batch lookup returned incomplete results',
      );
    }

    return states;
  }

  private parsePlatforms(value: string[] | null): Platform[] {
    if (!Array.isArray(value)) {
      throw new Error(
        'Canonical platform batch lookup returned invalid platforms',
      );
    }
    return value.map((platform) => {
      const parsed = this.parsePlatform(platform, false);
      if (parsed === null) {
        throw new Error(
          'Canonical platform batch lookup returned unknown platform',
        );
      }
      return parsed;
    });
  }

  private parsePlatform(
    value: string | null,
    allowNull = true,
  ): Platform | null {
    if (value === null && allowNull) return null;
    if (PLATFORMS.includes(value as Platform)) {
      return value as Platform;
    }
    throw new Error(
      'Canonical platform batch lookup returned unknown platform',
    );
  }
}
