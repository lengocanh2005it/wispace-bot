/**
 * Persistence seam for the Discord ↔ WISPACE mapping. The application layer
 * (account-linking use case) depends only on this port; the TypeORM
 * implementation lives in `infrastructure/persistence/`.
 */
export interface DiscordAccountLinkRepositoryPort {
  /**
   * Commits the mapping atomically: removes other links of the WISPACE user,
   * upserts the Discord id → user pair, and reports whether the Discord id
   * was previously linked to a different WISPACE user (relink overwrite).
   */
  upsertLink(
    userId: number,
    discordUserId: string,
  ): Promise<{ relinked: boolean; previousUserId?: number }>;
  findUserIdByDiscordId(discordUserId: string): Promise<number | undefined>;
  findDiscordIdByUserId(userId: number): Promise<string | undefined>;
}

export const DISCORD_ACCOUNT_LINK_REPOSITORY = Symbol(
  'DISCORD_ACCOUNT_LINK_REPOSITORY',
);
