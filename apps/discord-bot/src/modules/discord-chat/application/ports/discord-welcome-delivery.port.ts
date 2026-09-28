/**
 * Welcome-DM delivery from the chat gateway's point of view. The dedupe claim
 * and the "linked" vs "organic" wording live in the account-link feature, which
 * the composition root binds to the token below — the gateway only observes the
 * outcome it has to log.
 */
export type DiscordWelcomeDeliveryOutcome = 'sent' | 'skipped' | 'error';

export interface DiscordWelcomeDeliveryPort {
  /** Sends the linked welcome DM (if due) and reports the delivery outcome. */
  welcomeIfDue(
    discordUserId: string,
    displayName?: string,
    userId?: number,
  ): Promise<DiscordWelcomeDeliveryOutcome>;
  /**
   * Sends the organic welcome DM for an unlinked user who joined the guild,
   * under the same dedupe claim as the linked path.
   */
  sendOrganicWelcomeIfDue(
    discordUserId: string,
    displayName?: string,
  ): Promise<DiscordWelcomeDeliveryOutcome>;
}

export const DISCORD_WELCOME_DELIVERY = Symbol('DISCORD_WELCOME_DELIVERY');
