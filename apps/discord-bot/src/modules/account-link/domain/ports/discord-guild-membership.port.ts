/**
 * Guild-membership check boundary — the discord.js `Client` stays in the
 * infrastructure adapter (#428). Platform-specific per #467: it is NOT part
 * of the shared account-link core.
 */
export interface DiscordGuildMembershipPort {
  /**
   * Returns true if the user is a member of the configured DISCORD_GUILD_ID.
   * Fails closed when DISCORD_GUILD_ID is not set: membership cannot be
   * verified, so callers must defer the welcome to `guildMemberAdd` instead
   * of sending a DM into the void (#232).
   */
  isMember(discordUserId: string): Promise<boolean>;
}

export const DISCORD_GUILD_MEMBERSHIP = Symbol('DISCORD_GUILD_MEMBERSHIP');
