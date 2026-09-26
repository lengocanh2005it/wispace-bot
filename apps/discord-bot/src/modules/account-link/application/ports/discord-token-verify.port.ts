export interface DiscordTokenVerifyResult {
  valid: boolean;
  userId?: number;
  topic?: string;
  cadence?: string;
  statusCode?: number;
}

/** WISPACE token verification, kept out of the application layer (#1088). */
export interface DiscordTokenVerifyPort {
  verifyToken(
    token: string,
    discordUserId: string,
  ): Promise<DiscordTokenVerifyResult>;
}

export const DISCORD_TOKEN_VERIFY = Symbol('DISCORD_TOKEN_VERIFY');
