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
   * Atomically claims the welcome slot for `discordUserId` (single
   * conditional upsert, #159): wins when the user was never welcomed, the
   * last welcome is older than `windowMs`, or a previous claim expired.
   * Returns true only for the winner — a concurrent OAuth callback /
   * `guildMemberAdd` loses the claim instead of sending a duplicate DM.
   * The lease lasts `leaseMs`; a crashed/failed sender's claim becomes
   * reclaimable after it expires (retryable).
   */
  tryClaimWelcome(
    discordUserId: string,
    windowMs: number,
    leaseMs: number,
  ): Promise<boolean>;
  /**
   * Records a delivered welcome DM (upsert by Discord user id) and clears
   * the in-flight claim — only called after Discord acknowledged the send.
   */
  markWelcomed(discordUserId: string, source: WelcomeSource): Promise<void>;
}

export const DISCORD_WELCOME_RECORD_REPOSITORY = Symbol(
  'DISCORD_WELCOME_RECORD_REPOSITORY',
);
