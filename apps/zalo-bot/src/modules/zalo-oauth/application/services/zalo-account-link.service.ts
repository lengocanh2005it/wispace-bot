import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { maskExternalId } from '@wispace/bot-common';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';

const PLATFORM = 'zalo' as const;
const ZALO_TOKEN_ENDPOINT = 'https://oauth.zaloapp.com/v4/access_token';
const ZALO_ME_ENDPOINT = 'https://graph.zalo.me/v2.0/me';
const OAUTH_TIMEOUT_MS = 10_000;

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

    const tokenJson = (await tokenResponse.json()) as { access_token: string };

    const userResponse = await fetch(`${ZALO_ME_ENDPOINT}?fields=id,name`, {
      headers: { access_token: tokenJson.access_token },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!userResponse.ok) {
      throw new ZaloOauthError(
        `Zalo user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = (await userResponse.json()) as {
      id: string;
      name: string;
    };
    return { id: userJson.id, name: userJson.name };
  }

  async upsertLink(userId: number, zaloUserId: string): Promise<void> {
    await this.repo.manager.transaction(async (em) => {
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
        })
        .orUpdate(['userId', 'linkedAt'], ['platform', 'externalUserId'])
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
    return row?.userId;
  }
}
