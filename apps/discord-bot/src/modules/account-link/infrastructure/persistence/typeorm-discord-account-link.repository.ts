import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { acquireStudyReminderOwnershipMutationLock } from '@wispace/bot-common/locks';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type {
  LinkMappingObservation,
  LinkUpsertResult,
} from '@wispace/account-link-core/core';
import {
  cancelStudyReminderJobsForOwnershipChange,
  nextMappingGenerationAfterTombstone,
} from '@wispace/study-reminder-shared/adapters';
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
    mappingObservation: LinkMappingObservation,
  ): Promise<LinkUpsertResult> {
    let relinked = false;
    let previousUserId: number | undefined;
    let mappingGeneration: string | undefined;
    const displacedExternalUserIds: string[] = [];

    await this.repo.manager.transaction(async (em) => {
      await acquireStudyReminderOwnershipMutationLock(em);
      // Detect relink: the Discord id was previously mapped to a different
      // WISPACE user (the displaced user silently loses the link — #137 item 5).
      const existing = await em.query<
        Array<{
          user_id: number;
          mapping_generation?: string;
          link_state?: string;
        }>
      >(
        `WITH ownership_lock AS (
           SELECT pg_advisory_xact_lock(hashtext('study-reminder:ownership:' || $1 || ':' || $2))
         )
         SELECT user_id, mapping_generation, link_state
         FROM discord_account_links
         CROSS JOIN ownership_lock
         WHERE platform = $1 AND external_user_id = $2
         FOR UPDATE`,
        [PLATFORM, discordUserId],
      );
      const expectedGeneration =
        mappingObservation.kind === 'present'
          ? mappingObservation.generation
          : undefined;
      const alreadyCommitted =
        existing[0]?.user_id === userId &&
        (!existing[0]?.link_state || existing[0].link_state === 'active');
      if (alreadyCommitted) return;
      if (
        (mappingObservation.kind === 'present' &&
          (!existing[0] ||
            String(existing[0].mapping_generation ?? '1') !==
              expectedGeneration)) ||
        (mappingObservation.kind === 'absent' && existing[0])
      ) {
        throw new DiscordLinkOwnershipConflictError();
      }
      if (existing[0] && existing[0].user_id !== userId) {
        relinked = true;
        previousUserId = existing[0].user_id;
      }
      const insertGeneration = existing[0]
        ? '1'
        : await nextMappingGenerationAfterTombstone(
            em,
            PLATFORM,
            discordUserId,
          );
      if (!existing[0] && mappingObservation.kind === 'absent') {
        const previousGeneration = BigInt(insertGeneration) - 1n;
        if (
          (mappingObservation.generation === undefined &&
            previousGeneration > 0n) ||
          (mappingObservation.generation !== undefined &&
            previousGeneration.toString() !== mappingObservation.generation)
        ) {
          throw new DiscordLinkOwnershipConflictError();
        }
      }

      // Remove any existing link for this WISPACE user (re-linking with a different Discord account)
      const displacedRows = extractQueryRows<{ external_user_id: string }>(
        await em.query(
          `WITH candidates AS (
             SELECT external_user_id
             FROM discord_account_links
             WHERE platform = $1 AND user_id = $2 AND external_user_id != $3
             ORDER BY external_user_id
           ), ownership_locks AS (
             SELECT pg_advisory_xact_lock(
               hashtext('study-reminder:ownership:' || $1 || ':' || external_user_id)
             )
             FROM candidates
           )
           DELETE FROM discord_account_links link
           USING candidates, ownership_locks
           WHERE link.platform = $1
             AND link.user_id = $2
             AND link.external_user_id = candidates.external_user_id
           RETURNING link.external_user_id`,
          [PLATFORM, userId, discordUserId],
        ),
      );
      for (const row of displacedRows) {
        if (row.external_user_id) {
          displacedExternalUserIds.push(row.external_user_id);
          await cancelStudyReminderJobsForOwnershipChange(
            em,
            PLATFORM,
            row.external_user_id,
            { reason: 'mapping_ownership_changed' },
          );
        }
      }
      const rows = await em.query<
        Array<{
          external_user_id: string;
          mapping_generation?: string;
        }>
      >(
        `
          INSERT INTO discord_account_links
           (platform, external_user_id, user_id, link_state, mapping_generation)
           VALUES ($1, $2, $3, 'active', $6::bigint)
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
          WHERE NOT $4::boolean
            AND discord_account_links.mapping_generation = COALESCE($5::bigint, discord_account_links.mapping_generation)
           RETURNING external_user_id, mapping_generation
        `,
        [
          PLATFORM,
          discordUserId,
          userId,
          mappingObservation.kind === 'absent',
          expectedGeneration ?? null,
          insertGeneration,
        ],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        throw new DiscordLinkOwnershipConflictError();
      }
      mappingGeneration = rows[0]?.mapping_generation
        ? String(rows[0].mapping_generation)
        : undefined;
      if (mappingGeneration) {
        await cancelStudyReminderJobsForOwnershipChange(
          em,
          PLATFORM,
          discordUserId,
          {
            generation: mappingGeneration,
            reason: 'mapping_ownership_changed',
          },
        );
      }
    });

    return {
      relinked,
      ...(previousUserId !== undefined ? { previousUserId } : {}),
      ...(mappingGeneration ? { mappingGeneration } : {}),
      ...(displacedExternalUserIds.length > 0
        ? { displacedExternalUserIds }
        : {}),
    };
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

  async claimConsentPrompt(discordUserId: string): Promise<boolean> {
    const rows = extractQueryRows<{ id: string }>(
      await this.repo.query(
        `UPDATE discord_account_links
       SET optin_prompt_sent_at = now(), updated_at = now()
       WHERE platform = $1 AND external_user_id = $2
         AND optin_prompt_sent_at IS NULL
       RETURNING id`,
        [PLATFORM, discordUserId],
      ),
    );
    return rows.length > 0;
  }

  async releaseConsentPrompt(discordUserId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(DiscordAccountLinkEntity)
      .set({ optinPromptSentAt: null as never })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :discordUserId', { discordUserId })
      .execute();
  }

  async markOptOutNoticeSent(discordUserId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(DiscordAccountLinkEntity)
      .set({ optoutNoticeSentAt: new Date() })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :discordUserId', { discordUserId })
      .execute();
  }
}
