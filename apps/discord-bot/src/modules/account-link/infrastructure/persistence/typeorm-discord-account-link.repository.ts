import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import type { DiscordAccountLinkRepositoryPort } from '../../domain/ports/discord-account-link.repository.port';

const PLATFORM = 'discord' as const;

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
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    let relinked = false;
    let previousUserId: number | undefined;

    await this.repo.manager.transaction(async (em) => {
      // Detect relink: the Discord id was previously mapped to a different
      // WISPACE user (the displaced user silently loses the link — #137 item 5).
      const existing = await em.query<Array<{ user_id: number }>>(
        `SELECT user_id FROM discord_account_links
         WHERE platform = $1 AND external_user_id = $2`,
        [PLATFORM, discordUserId],
      );
      if (existing[0] && existing[0].user_id !== userId) {
        relinked = true;
        previousUserId = existing[0].user_id;
      }

      // Remove any existing link for this WISPACE user (re-linking with a different Discord account)
      await em.query(
        `DELETE FROM discord_account_links WHERE platform = $1 AND user_id = $2 AND external_user_id != $3`,
        [PLATFORM, userId, discordUserId],
      );
      await em.query(
        `
          INSERT INTO discord_account_links (platform, external_user_id, user_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (platform, external_user_id)
          DO UPDATE SET user_id = EXCLUDED.user_id, linked_at = now()
        `,
        [PLATFORM, discordUserId, userId],
      );
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

    return row?.userId;
  }

  async findLinkByDiscordId(
    discordUserId: string,
  ): Promise<{ userId: number; mappingVersion: string } | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: { id: true, userId: true, linkedAt: true },
    });
    return row
      ? {
          userId: row.userId,
          mappingVersion: `${row.id}:${row.linkedAt.toISOString()}`,
        }
      : undefined;
  }

  async findDiscordIdByUserId(userId: number): Promise<string | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, userId },
      select: { externalUserId: true },
    });

    return row?.externalUserId;
  }
}
