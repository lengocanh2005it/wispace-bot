/**
 * Discord OAuth2 provider boundary — token exchange + user identity fetch
 * live in the infrastructure adapter; the application service keeps only
 * orchestration (#428). State/token cryptography stays per app (#467 scope).
 */
export interface DiscordOauthExchangePort {
  /** Exchanges the OAuth2 `code` for Discord user info (`identify` scope). */
  exchangeCodeForDiscordUser(
    code: string,
  ): Promise<{ id: string; username: string }>;
}

export const DISCORD_OAUTH_EXCHANGE = Symbol('DISCORD_OAUTH_EXCHANGE');
