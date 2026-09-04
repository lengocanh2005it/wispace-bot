import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { maskExternalId, errorMessage } from '@wispace/bot-common/masking';
import { buildConsentExplainerMessage } from '@wispace/bot-common/messages';
import { readBoundedJson } from '@wispace/bot-common/utils';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';

const PLATFORM = 'zalo' as const;
const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_ME_ENDPOINT = 'https://graph.zalo.me/v2.0/me';
const OAUTH_TIMEOUT_MS = 10_000;

export class ZaloLinkOwnershipConflictError extends Error {
  constructor() {
    super('Zalo link ownership changed or is revoked');
    this.name = 'ZaloLinkOwnershipConflictError';
  }
}

class ZaloOauthError extends Error {}

/**
 * Zalo Login OAuth (PKCE) + account-linking to WISPACE userId — Zalo
 * counterpart to apps/discord-bot's DiscordAccountLinkService. Zalo Login
 * requires PKCE, unlike Discord's plain OAuth2 (spec §5.2).
 */
@Injectable()
export class ZaloAccountLinkService {
  private readonly logger = new Logger(ZaloAccountLinkService.name);

  constructor(
    private readonly configService: ConfigService,
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
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const secretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );

    const tokenResponse = await fetch(ZALO_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        secret_key: secretKey,
      },
      body: new URLSearchParams({
        code,
        app_id: appId,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!tokenResponse.ok) {
      throw new ZaloOauthError(
        `Zalo token exchange failed: ${tokenResponse.status}`,
      );
    }

    const tokenJson = await readBoundedJson<{ access_token: string }>(
      tokenResponse,
    );

    const userResponse = await fetch(`${ZALO_ME_ENDPOINT}?fields=id,name`, {
      headers: { access_token: tokenJson.access_token },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!userResponse.ok) {
      throw new ZaloOauthError(
        `Zalo user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = await readBoundedJson<{
      id: string;
      name: string;
    }>(userResponse);
    return { id: userJson.id, name: userJson.name };
  }

  async upsertLink(
    userId: number,
    zaloUserId: string,
    options: { expectedGeneration?: string } = {},
  ): Promise<void> {
    await this.repo.manager.transaction(async (em) => {
      // Keep the test seam's query-builder fallback; production uses one
      // atomic SQL upsert so a status worker cannot overwrite a relinked
      // generation between read and write.
      if (typeof em.query === 'function') {
        const existingRows = await em.query<
          Array<{ mapping_generation?: string }>
        >(
          `SELECT mapping_generation
           FROM zalo_account_links
           WHERE platform = $1 AND external_user_id = $2
           FOR UPDATE`,
          [PLATFORM, zaloUserId],
        );
        if (
          options.expectedGeneration !== undefined &&
          existingRows[0] &&
          String(existingRows[0].mapping_generation ?? '1') !==
            options.expectedGeneration
        ) {
          throw new ZaloLinkOwnershipConflictError();
        }
        await em.query(
          `DELETE FROM zalo_account_links
           WHERE platform = $1 AND user_id = $2 AND external_user_id != $3`,
          [PLATFORM, userId, zaloUserId],
        );
        const rows = await em.query<Array<{ external_user_id: string }>>(
          `INSERT INTO zalo_account_links
             (platform, external_user_id, user_id, link_state, mapping_generation)
           VALUES ($1, $2, $3, 'active', 1)
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
           WHERE zalo_account_links.mapping_generation = COALESCE($4::bigint, zalo_account_links.mapping_generation)
           RETURNING external_user_id`,
          [PLATFORM, zaloUserId, userId, options.expectedGeneration ?? null],
        );
        if (Array.isArray(rows) && rows.length === 0) {
          throw new ZaloLinkOwnershipConflictError();
        }
        return;
      }

      const existing = await this.repo.findOne({
        where: { platform: PLATFORM, externalUserId: zaloUserId },
        select: { linkState: true, mappingGeneration: true },
      });
      if (
        options.expectedGeneration !== undefined &&
        (!existing ||
          String(existing.mappingGeneration ?? '1') !==
            options.expectedGeneration)
      ) {
        throw new ZaloLinkOwnershipConflictError();
      }
      const mappingGeneration =
        existing?.linkState && existing.linkState !== 'active'
          ? String(BigInt(existing.mappingGeneration ?? '1') + 1n)
          : (existing?.mappingGeneration ?? '1');

      await em
        .createQueryBuilder()
        .delete()
        .from(ZaloAccountLinkEntity)
        .where(
          'platform = :platform AND userId = :userId AND externalUserId != :externalUserId',
          {
            platform: PLATFORM,
            userId,
            externalUserId: zaloUserId,
          },
        )
        .execute();

      await em
        .createQueryBuilder()
        .insert()
        .into(ZaloAccountLinkEntity)
        .values({
          platform: PLATFORM,
          externalUserId: zaloUserId,
          userId,
          linkState: 'active',
          mappingGeneration,
          revokedAt: null,
          revocationReason: null,
        })
        .orUpdate(
          [
            'userId',
            'linkedAt',
            'updatedAt',
            'linkState',
            'mappingGeneration',
            'revokedAt',
            'revocationReason',
          ],
          ['platform', 'externalUserId'],
        )
        .execute();
    });

    this.logger.log(
      `Linked Zalo account zaloUserId=${maskExternalId(
        zaloUserId,
      )} userId=${maskExternalId(userId)}`,
    );
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
