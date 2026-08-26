import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Platform } from '../types';
import { UserNotificationPreferenceEntity } from '../entities/user-notification-preference.entity';

export const DEFAULT_PLATFORM_PRIORITY: Platform[] = [
  'zalo',
  'discord',
  'messenger',
];

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
    const rows: Array<{
      preferred_platform: Platform | null;
      zalo_id: string | null;
      discord_id: string | null;
      messenger_id: string | null;
    }> = await this.dataSource.query(
      `
      SELECT
        pref.preferred_platform,
        (SELECT zal.external_user_id FROM zalo_account_links zal WHERE zal.user_id = $1 LIMIT 1) AS zalo_id,
        (SELECT dal.external_user_id FROM discord_account_links dal WHERE dal.user_id = $1 LIMIT 1) AS discord_id,
        (SELECT upm.external_user_id FROM user_platform_mappings upm WHERE upm.user_id = $1 AND upm.status = 'ACTIVE' LIMIT 1) AS messenger_id
      FROM (SELECT $1::int AS user_id) u
      LEFT JOIN user_notification_preferences pref ON pref.user_id = u.user_id
      `,
      [userId],
    );

    if (rows.length === 0) {
      return { activePlatforms: [], preferredPlatform: null };
    }

    const row = rows[0];
    const activePlatforms: Platform[] = [];
    if (row.zalo_id) activePlatforms.push('zalo');
    if (row.discord_id) activePlatforms.push('discord');
    if (row.messenger_id) activePlatforms.push('messenger');

    return {
      activePlatforms,
      preferredPlatform: row.preferred_platform ?? null,
    };
  }

  /**
   * Resolve the canonical delivery platform for a WISPACE userId.
   * Returns undefined if the user has no active links on any platform.
   */
  async getCanonicalPlatformForUser(
    userId: number,
  ): Promise<Platform | undefined> {
    const { activePlatforms, preferredPlatform } =
      await this.getActivePlatformsForUser(userId);
    return resolveCanonicalPlatform(activePlatforms, preferredPlatform);
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
}
