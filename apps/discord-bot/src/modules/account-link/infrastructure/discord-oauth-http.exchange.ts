import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readBoundedJson } from '@wispace/bot-common/utils';
import type { DiscordOauthExchangePort } from '../domain/ports/discord-oauth-exchange.port';

const OAUTH_TIMEOUT_MS = 10_000;

export class DiscordOauthError extends Error {}

/**
 * Discord OAuth2 HTTP exchange — token endpoint + user identity, moved out
 * of the application service to the infrastructure boundary (#428).
 */
@Injectable()
export class DiscordOauthHttpExchange implements DiscordOauthExchangePort {
  constructor(private readonly configService: ConfigService) {}

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
}
