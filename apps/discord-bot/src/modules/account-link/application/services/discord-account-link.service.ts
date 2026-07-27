import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordAccountLinkEntity } from '../../../../infrastructure/database/entities/discord-account-link.entity';

const PLATFORM = 'discord' as const;

const OAUTH_TIMEOUT_MS = 10_000;

class DiscordOauthError extends Error {}

@Injectable()
export class DiscordAccountLinkService {
  private readonly logger = new Logger(DiscordAccountLinkService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly repo: Repository<DiscordAccountLinkEntity>,
  ) {}

  /** Exchanges the OAuth2 `code` for Discord user info (`identify` scope). */
  async exchangeCodeForDiscordUser(
    code: string,
  ): Promise<{ id: string; username: string }> {
    const clientId = this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
    const clientSecret = this.configService.getOrThrow<string>(
      'DISCORD_CLIENT_SECRET',
    );
    const redirectUri = this.configService.getOrThrow<string>(
      'DISCORD_OAUTH_REDIRECT_URI',
    );

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!tokenResponse.ok) {
      throw new DiscordOauthError(
        `Discord token exchange failed: ${tokenResponse.status}`,
      );
    }

    const tokenJson = (await tokenResponse.json()) as { access_token: string };

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!userResponse.ok) {
      throw new DiscordOauthError(
        `Discord user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string;
    };
    return {
      id: userJson.id,
      username: userJson.global_name ?? userJson.username,
    };
  }

  async upsertLink(userId: number, discordUserId: string): Promise<void> {
    await this.repo.manager.transaction(async (em) => {
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

    this.logger.log(
      `Linked Discord account discordUserId=${discordUserId} userId=${userId}`,
    );
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
}
