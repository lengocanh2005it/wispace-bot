/**
 * The WISPACE identity behind a Discord account, as the chat feature needs to
 * read it. `discord-chat` must not reach into `account-link`'s concrete link
 * service, so the composition root binds that service to the token below.
 */
export interface DiscordLinkedIdentity {
  userId: number;
  /** Version stamp for optimistic mapping checks on write flows. */
  mappingVersion: string;
}

export interface DiscordLinkedIdentityPort {
  /** The linked WISPACE user id, or `undefined` when the account is unlinked. */
  findUserIdByDiscordId(discordUserId: string): Promise<number | undefined>;
  /**
   * The current identity plus its mapping version, or `undefined` when the
   * Discord account has no link row.
   */
  findCurrentIdentity(
    discordUserId: string,
  ): Promise<DiscordLinkedIdentity | undefined>;
}

export const DISCORD_LINKED_IDENTITY = Symbol('DISCORD_LINKED_IDENTITY');
