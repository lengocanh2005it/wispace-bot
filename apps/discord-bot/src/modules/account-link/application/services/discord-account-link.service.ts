import { Injectable, Logger, Inject } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { buildConsentExplainerMessage } from '@wispace/bot-common/messages';
import {
  DISCORD_ACCOUNT_LINK_REPOSITORY,
  type DiscordAccountLinkRepositoryPort,
} from '../../domain/ports/discord-account-link.repository.port';
import {
  DISCORD_OAUTH_EXCHANGE,
  type DiscordOauthExchangePort,
} from '../../domain/ports/discord-oauth-exchange.port';

/**
 * Discord OAuth account-linking use case. Persistence flows through
 * `DiscordAccountLinkRepositoryPort` and the Discord OAuth2 HTTP exchange
 * through `DiscordOauthExchangePort` — both bound to infrastructure
 * implementations in module wiring (#428).
 */
@Injectable()
export class DiscordAccountLinkService {
  private readonly logger = new Logger(DiscordAccountLinkService.name);

  constructor(
    @Inject(DISCORD_OAUTH_EXCHANGE)
    private readonly oauthExchange: DiscordOauthExchangePort,
    @Inject(DISCORD_ACCOUNT_LINK_REPOSITORY)
    private readonly repository: DiscordAccountLinkRepositoryPort,
  ) {}

  /** Exchanges the OAuth2 `code` for Discord user info (`identify` scope). */
  async exchangeCodeForDiscordUser(
    code: string,
  ): Promise<{ id: string; username: string }> {
    return this.oauthExchange.exchangeCodeForDiscordUser(code);
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
