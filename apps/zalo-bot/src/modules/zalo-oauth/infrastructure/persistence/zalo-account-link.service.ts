import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { acquireStudyReminderOwnershipMutationLock } from '@wispace/bot-common/locks';
import { maskExternalId, errorMessage } from '@wispace/bot-common/masking';
import { buildConsentExplainerMessage } from '@wispace/bot-common/messages';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type {
  LinkMappingObservation,
  LinkUpsertResult,
} from '@wispace/account-link-core/core';
import {
  cancelStudyReminderJobsForOwnershipChange,
  nextMappingGenerationAfterTombstone,
} from '@wispace/study-reminder-shared/adapters';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import {
  ZALO_OAUTH_CLIENT,
  type ZaloOAuthClientPort,
} from '../../application/ports/zalo-oauth-client.port';
import type { ZaloAccountLinkPort } from '../../domain/ports/zalo-account-link.port';

const PLATFORM = 'zalo' as const;

export class ZaloLinkOwnershipConflictError extends Error {
  constructor() {
    super('Zalo link ownership changed or is revoked');
    this.name = 'ZaloLinkOwnershipConflictError';
  }
}

/**
 * Zalo Login OAuth (PKCE) + account-linking to WISPACE userId — Zalo
 * counterpart to apps/discord-bot's DiscordAccountLinkService. Zalo Login
 * requires PKCE, unlike Discord's plain OAuth2 (spec §5.2).
 */
@Injectable()
export class ZaloAccountLinkService implements ZaloAccountLinkPort {
  private readonly logger = new Logger(ZaloAccountLinkService.name);

  constructor(
    @Inject(ZALO_OAUTH_CLIENT)
    private readonly oauthClient: ZaloOAuthClientPort,
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly repo: Repository<ZaloAccountLinkEntity>,
  ) {}

  buildPkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest()
      .toString('base64url');
    return { codeVerifier, codeChallenge };
  }

  async exchangeCodeForZaloUser(
    code: string,
    codeVerifier: string,
  ): Promise<{ id: string; name: string }> {
    return this.oauthClient.exchangeCodeForUser(code, codeVerifier);
  }

  async upsertLink(
    userId: number,
    zaloUserId: string,
    mappingObservation: LinkMappingObservation,
  ): Promise<LinkUpsertResult> {
    let relinked = false;
    let previousUserId: number | undefined;
    let mappingGeneration: string | undefined;
    const displacedExternalUserIds: string[] = [];
    await this.repo.manager.transaction(async (em) => {
      await acquireStudyReminderOwnershipMutationLock(em);
      const existingRows = await em.query<
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
         FROM zalo_account_links
         CROSS JOIN ownership_lock
         WHERE platform = $1 AND external_user_id = $2
         FOR UPDATE`,
        [PLATFORM, zaloUserId],
      );
      const expectedGeneration =
        mappingObservation.kind === 'present'
          ? mappingObservation.generation
          : undefined;
      const alreadyCommitted =
        existingRows[0]?.user_id === userId &&
        (!existingRows[0]?.link_state ||
          existingRows[0].link_state === 'active');
      if (alreadyCommitted) return;
      if (
        (mappingObservation.kind === 'present' &&
          (!existingRows[0] ||
            String(existingRows[0].mapping_generation ?? '1') !==
              expectedGeneration)) ||
        (mappingObservation.kind === 'absent' && existingRows[0])
      ) {
        throw new ZaloLinkOwnershipConflictError();
      }
      if (existingRows[0] && existingRows[0].user_id !== userId) {
        relinked = true;
        previousUserId = existingRows[0].user_id;
      }
      const insertGeneration = existingRows[0]
        ? '1'
        : await nextMappingGenerationAfterTombstone(em, PLATFORM, zaloUserId);
      if (!existingRows[0] && mappingObservation.kind === 'absent') {
        const previousGeneration = BigInt(insertGeneration) - 1n;
        if (
          (mappingObservation.generation === undefined &&
            previousGeneration > 0n) ||
          (mappingObservation.generation !== undefined &&
            previousGeneration.toString() !== mappingObservation.generation)
        ) {
          throw new ZaloLinkOwnershipConflictError();
        }
      }
      const displacedRows = extractQueryRows<{ external_user_id: string }>(
        await em.query(
          `WITH candidates AS (
             SELECT external_user_id
             FROM zalo_account_links
             WHERE platform = $1 AND user_id = $2 AND external_user_id != $3
             ORDER BY external_user_id
           ), ownership_locks AS (
             SELECT pg_advisory_xact_lock(
               hashtext('study-reminder:ownership:' || $1 || ':' || external_user_id)
             )
             FROM candidates
           )
           DELETE FROM zalo_account_links link
           USING candidates, ownership_locks
           WHERE link.platform = $1
             AND link.user_id = $2
             AND link.external_user_id = candidates.external_user_id
          RETURNING link.external_user_id`,
          [PLATFORM, userId, zaloUserId],
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
        `INSERT INTO zalo_account_links
           (platform, external_user_id, user_id, link_state, mapping_generation)
           VALUES ($1, $2, $3, 'active', $6::bigint)
         ON CONFLICT (platform, external_user_id)
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           linked_at = now(),
           updated_at = now(),
           link_state = 'active',
           mapping_generation = CASE
             WHEN zalo_account_links.link_state <> 'active'
               OR zalo_account_links.user_id <> EXCLUDED.user_id
               THEN zalo_account_links.mapping_generation + 1
             ELSE zalo_account_links.mapping_generation
           END,
           revoked_at = NULL,
           revocation_reason = NULL
         WHERE NOT $4::boolean
           AND zalo_account_links.mapping_generation = COALESCE($5::bigint, zalo_account_links.mapping_generation)
         RETURNING external_user_id, mapping_generation`,
        [
          PLATFORM,
          zaloUserId,
          userId,
          mappingObservation.kind === 'absent',
          expectedGeneration ?? null,
          insertGeneration,
        ],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        throw new ZaloLinkOwnershipConflictError();
      }
      mappingGeneration = rows[0]?.mapping_generation
        ? String(rows[0].mapping_generation)
        : undefined;
      if (mappingGeneration) {
        await cancelStudyReminderJobsForOwnershipChange(
          em,
          PLATFORM,
          zaloUserId,
          {
            generation: mappingGeneration,
            reason: 'mapping_ownership_changed',
          },
        );
      }
    });

    this.logger.log(
      `Linked Zalo account zaloUserId=${maskExternalId(
        zaloUserId,
      )} userId=${maskExternalId(userId)}${
        relinked && previousUserId !== undefined
          ? ` relinked=previousUserId=${maskExternalId(previousUserId)}`
          : ''
      }`,
    );

    return {
      relinked,
      ...(previousUserId !== undefined ? { previousUserId } : {}),
      ...(mappingGeneration ? { mappingGeneration } : {}),
      ...(displacedExternalUserIds.length > 0
        ? { displacedExternalUserIds }
        : {}),
    };
  }

  async findUserIdByZaloId(zaloUserId: string): Promise<number | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: zaloUserId },
      select: { userId: true },
    });
    return row && (!row.linkState || row.linkState === 'active')
      ? row.userId
      : undefined;
  }

  async findMappingStateByZaloId(zaloUserId: string): Promise<{
    state: import('@wispace/contracts').PlatformLinkState;
    userId?: number;
  }> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: zaloUserId },
      select: { userId: true, linkState: true },
    });
    return row
      ? { state: row.linkState ?? 'active', userId: row.userId }
      : { state: 'locally-unlinked' };
  }

  async findCurrentIdentity(zaloUserId: string): Promise<
    | {
        userId: number;
        mappingVersion: string;
      }
    | undefined
  > {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: zaloUserId },
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

  /**
   * Post-link consent explainer, exactly once per link (#596). The claim is
   * atomic; a failed send releases it so a later reconnect can retry.
   */
  async sendConsentExplainerIfDue(
    zaloUserId: string,
    send: (text: string) => Promise<void>,
  ): Promise<boolean> {
    let claimed = false;
    try {
      claimed = await this.claimConsentPrompt(zaloUserId);
      if (!claimed) return false;
      await send(buildConsentExplainerMessage());
      return true;
    } catch (error) {
      if (claimed) {
        await this.releaseConsentPrompt(zaloUserId).catch(() => undefined);
      }
      this.logger.warn(
        `Consent explainer send failed zaloUserId=${maskExternalId(
          zaloUserId,
        )}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private async claimConsentPrompt(zaloUserId: string): Promise<boolean> {
    const rows = extractQueryRows<{ id: string }>(
      await this.repo.query(
        `UPDATE zalo_account_links
       SET optin_prompt_sent_at = now(), updated_at = now()
       WHERE platform = $1 AND external_user_id = $2
         AND optin_prompt_sent_at IS NULL
       RETURNING id`,
        [PLATFORM, zaloUserId],
      ),
    );
    return rows.length > 0;
  }

  private async releaseConsentPrompt(zaloUserId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(ZaloAccountLinkEntity)
      .set({ optinPromptSentAt: null as never })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :zaloUserId', { zaloUserId })
      .execute();
  }

  /** Explicit report opt-in via command knows the toggle — no footer (#596). */
  async suppressOptOutNotice(zaloUserId: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(ZaloAccountLinkEntity)
      .set({ optoutNoticeSentAt: new Date() })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :zaloUserId', { zaloUserId })
      .execute();
  }
}
