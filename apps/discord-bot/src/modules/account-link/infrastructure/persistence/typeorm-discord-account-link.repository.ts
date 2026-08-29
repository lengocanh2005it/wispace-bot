import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import type { DiscordAccountLinkRepositoryPort } from '../../domain/ports/discord-account-link.repository.port';

const PLATFORM = 'discord' as const;

export class DiscordLinkOwnershipConflictError extends Error {
  constructor() {
    super('Discord link ownership changed or is revoked');
    this.name = 'DiscordLinkOwnershipConflictError';
  }
}

/** TypeORM implementation of `DiscordAccountLinkRepositoryPort`. */
@Injectable()
export class TypeormDiscordAccountLinkRepository implements DiscordAccountLinkRepositoryPort {
  constructor(
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly repo: Repository<DiscordAccountLinkEntity>,
  ) {}

  async upsertLink(
    userId: number,
    discordUserId: string,
    options: { expectedGeneration?: string } = {},
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    let relinked = false;
    let previousUserId: number | undefined;

    await this.repo.manager.transaction(async (em) => {
      // Detect relink: the Discord id was previously mapped to a different
      // WISPACE user (the displaced user silently loses the link — #137 item 5).
      const existing = await em.query<
        Array<{
          user_id: number;
          mapping_generation?: string;
          link_state?: string;
        }>
      >(
        `SELECT user_id, mapping_generation, link_state
         FROM discord_account_links
         WHERE platform = $1 AND external_user_id = $2
         FOR UPDATE`,
        [PLATFORM, discordUserId],
      );
      if (
        options.expectedGeneration !== undefined &&
        existing[0] &&
        String(existing[0].mapping_generation ?? '1') !==
          options.expectedGeneration
      ) {
        throw new DiscordLinkOwnershipConflictError();
      }
      if (existing[0] && existing[0].user_id !== userId) {
        relinked = true;
        previousUserId = existing[0].user_id;
      }

      // Remove any existing link for this WISPACE user (re-linking with a different Discord account)
      await em.query(
        `DELETE FROM discord_account_links WHERE platform = $1 AND user_id = $2 AND external_user_id != $3`,
        [PLATFORM, userId, discordUserId],
      );
      const rows = await em.query<Array<{ external_user_id: string }>>(
        `
          INSERT INTO discord_account_links
            (platform, external_user_id, user_id, link_state, mapping_generation)
          VALUES ($1, $2, $3, 'active', 1)
          ON CONFLICT (platform, external_user_id)
          DO UPDATE SET
            user_id = EXCLUDED.user_id,
            linked_at = now(),
            updated_at = now(),
            link_state = 'active',
            mapping_generation = CASE
              WHEN discord_account_links.link_state <> 'active'
                OR discord_account_links.user_id <> EXCLUDED.user_id
                THEN discord_account_links.mapping_generation + 1
              ELSE discord_account_links.mapping_generation
            END,
            revoked_at = NULL,
            revocation_reason = NULL
          WHERE discord_account_links.mapping_generation = COALESCE($4::bigint, discord_account_links.mapping_generation)
          RETURNING external_user_id
        `,
        [PLATFORM, discordUserId, userId, options.expectedGeneration ?? null],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        throw new DiscordLinkOwnershipConflictError();
      }
    });

    return { relinked, previousUserId };
  }

  async findUserIdByDiscordId(
    discordUserId: string,
  ): Promise<number | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: { userId: true },
    });

    return row && (!row.linkState || row.linkState === 'active')
      ? row.userId
      : undefined;
  }

  async findMappingStateByDiscordId(discordUserId: string): Promise<{
    state: import('@wispace/contracts').PlatformLinkState;
    userId?: number;
  }> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: { userId: true, linkState: true },
    });
    return row
      ? { state: row.linkState ?? 'active', userId: row.userId }
      : { state: 'locally-unlinked' };
  }

  async findLinkByDiscordId(
    discordUserId: string,
  ): Promise<{ userId: number; mappingVersion: string } | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: {
        id: true,
        userId: true,
        linkedAt: true,
        linkState: true,
        mappingGeneration: true,
      },
    });
    if (row?.linkState && row.linkState !== 'active') return undefined;
    return row
      ? {
          userId: row.userId,
          mappingVersion: `${row.id}:${row.linkedAt.toISOString()}:${row.mappingGeneration ?? '1'}`,
        }
      : undefined;
  }

  async findDiscordIdByUserId(userId: number): Promise<string | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, userId },
      select: { externalUserId: true, linkState: true },
    });

    return row && (!row.linkState || row.linkState === 'active')
      ? row.externalUserId
      : undefined;
  }
}
