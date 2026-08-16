/**
 * Persistence seam for welcome-DM dedupe state, keyed by Discord user id
 * alone — an unlinked user may never get a `discord_account_links` mapping
 * row, but the welcome state must still exist (#231). One shared record for
 * the organic and the linked path: a user welcomed organically is not
 * welcomed again at link time within the window (#233).
 */
export type WelcomeSource = 'organic' | 'linked';

export interface DiscordWelcomeRecordRepositoryPort {
  /**
   * True when no welcome DM was delivered yet, or the last one is older than
   * `windowMs` — a user is never welcomed twice within the window (re-join
   * spam, join-then-link duplicate, #231/#233).
   */
  shouldWelcome(discordUserId: string, windowMs: number): Promise<boolean>;
  /** Records a delivered welcome DM (upsert by Discord user id). */
  markWelcomed(discordUserId: string, source: WelcomeSource): Promise<void>;
}

export const DISCORD_WELCOME_RECORD_REPOSITORY = Symbol(
  'DISCORD_WELCOME_RECORD_REPOSITORY',
);
