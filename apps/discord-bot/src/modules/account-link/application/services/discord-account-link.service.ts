import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import { readBoundedJson } from '@wispace/bot-common/utils';
import {
  DISCORD_ACCOUNT_LINK_REPOSITORY,
  type DiscordAccountLinkRepositoryPort,
} from '../../domain/ports/discord-account-link.repository.port';

const OAUTH_TIMEOUT_MS = 10_000;

class DiscordOauthError extends Error {}

/**
 * Discord OAuth account-linking use case. Persistence flows through
 * `DiscordAccountLinkRepositoryPort` (bound to the TypeORM implementation in
 * module wiring); the WISPACE/Discord HTTP exchange lives here.
 */
@Injectable()
export class DiscordAccountLinkService {
  private readonly logger = new Logger(DiscordAccountLinkService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(DISCORD_ACCOUNT_LINK_REPOSITORY)
    private readonly repository: DiscordAccountLinkRepositoryPort,
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

    const tokenJson = await readBoundedJson<{ access_token: string }>(
      tokenResponse,
    );

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!userResponse.ok) {
      throw new DiscordOauthError(
        `Discord user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = await readBoundedJson<{
      id: string;
      username: string;
      global_name?: string;
    }>(userResponse);
    return {
      id: userJson.id,
      username: userJson.global_name ?? userJson.username,
    };
  }

  async upsertLink(
    userId: number,
    discordUserId: string,
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    const result = await this.repository.upsertLink(userId, discordUserId);

    this.logger.log(
      `Linked Discord account discordUserId=${maskExternalId(
        discordUserId,
      )} userId=${maskExternalId(userId)}${
        result.relinked && result.previousUserId !== undefined
          ? ` relinked=previousUserId=${maskExternalId(result.previousUserId)}`
          : ''
      }`,
    );

    return result;
  }

  async findUserIdByDiscordId(
    discordUserId: string,
  ): Promise<number | undefined> {
    return this.repository.findUserIdByDiscordId(discordUserId);
  }

  async findDiscordIdByUserId(userId: number): Promise<string | undefined> {
    return this.repository.findDiscordIdByUserId(userId);
  }
}
