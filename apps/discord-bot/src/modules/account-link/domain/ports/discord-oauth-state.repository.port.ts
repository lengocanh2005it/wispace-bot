/**
 * Persistence contract for single-use OAuth link states — the application
 * service owns state generation, TTL judgment, and AES-GCM decryption; the
 * TypeORM implementation lives in `infrastructure/persistence/` (#428).
 */
export interface DiscordOauthStateRepositoryPort {
  saveState(input: {
    state: string;
    encryptedLinkToken: string;
    createdAt: Date;
  }): Promise<void>;
  /**
   * Atomic single-use consume: deletes the row and returns it — `undefined`
   * when the state does not exist.
   */
  deleteByState(
    state: string,
  ): Promise<{ linkToken: string; createdAt: Date } | undefined>;
  /** Opportunistic bounded cleanup of rows older than the state TTL. */
  deleteExpiredBefore(cutoff: Date, limit: number): Promise<void>;
}

export const DISCORD_OAUTH_STATE_REPOSITORY = Symbol(
  'DISCORD_OAUTH_STATE_REPOSITORY',
);
