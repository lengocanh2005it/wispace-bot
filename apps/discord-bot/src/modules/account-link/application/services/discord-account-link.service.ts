import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { buildConsentExplainerMessage } from '@wispace/bot-common/messages';
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
    options: { expectedGeneration?: string } = {},
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    const result =
      options.expectedGeneration === undefined
        ? await this.repository.upsertLink(userId, discordUserId)
        : await this.repository.upsertLink(userId, discordUserId, options);

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

  async findMappingStateByDiscordId(discordUserId: string): Promise<{
    state: import('@wispace/contracts').PlatformLinkState;
    userId?: number;
  }> {
    if (this.repository.findMappingStateByDiscordId) {
      return this.repository.findMappingStateByDiscordId(discordUserId);
    }
    const userId = await this.repository.findUserIdByDiscordId(discordUserId);
    return userId === undefined
      ? { state: 'locally-unlinked' }
      : { state: 'active', userId };
  }

  async findCurrentIdentity(discordUserId: string): Promise<
    | {
        userId: number;
        mappingVersion: string;
      }
    | undefined
  > {
    const link = await this.repository.findLinkByDiscordId?.(discordUserId);
    if (link) return link;
    const userId = await this.repository.findUserIdByDiscordId(discordUserId);
    return userId === undefined
      ? undefined
      : { userId, mappingVersion: `legacy:${userId}` };
  }

  async findDiscordIdByUserId(userId: number): Promise<string | undefined> {
    return this.repository.findDiscordIdByUserId(userId);
  }

  /**
   * Post-link consent explainer, exactly once per link (#596). The claim is
   * atomic; a failed send releases it so `guildMemberAdd` can retry.
   */
  async sendConsentExplainerIfDue(
    discordUserId: string,
    send: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (!this.repository.claimConsentPrompt) return false;
    let claimed = false;
    try {
      claimed = await this.repository.claimConsentPrompt(discordUserId);
      if (!claimed) return false;
      await send(buildConsentExplainerMessage());
      return true;
    } catch (error) {
      if (claimed && this.repository.releaseConsentPrompt) {
        await this.repository
          .releaseConsentPrompt(discordUserId)
          .catch(() => undefined);
      }
      this.logger.warn(
        `Consent explainer send failed discordUserId=${maskExternalId(
          discordUserId,
        )}: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Explicit report opt-in via command knows the toggle — no footer (#596). */
  async suppressOptOutNotice(discordUserId: string): Promise<void> {
    await this.repository.markOptOutNoticeSent?.(discordUserId);
  }
}
