import type { OutboundDeliveryOutcome } from '@wispace/contracts';

/**
 * Direct-message delivery the account-link flow owns: the relink notice, the
 * linked welcome and the consent explainer. `account-link` must not reach into
 * `discord-chat`'s concrete outbound service, so the composition root binds the
 * adapter that already implements this capability to the token below.
 */
export interface DiscordOutboundMessagingPort {
  /** Sends a plain DM; resolves to the provider's delivery verdict. */
  sendText(
    discordUserId: string,
    text: string,
    options?: { userId?: number },
  ): Promise<OutboundDeliveryOutcome>;
  /**
   * Sends the persistent quick-action menu DM. Resolves to true only when the
   * provider acknowledged it — a privacy-blocked DM resolves false, so the
   * caller decides whether the welcome counts as delivered (#232).
   */
  sendMenuButtons(
    discordUserId: string,
    content?: string,
    userId?: number,
  ): Promise<boolean>;
}

export const DISCORD_OUTBOUND_MESSAGING = Symbol('DISCORD_OUTBOUND_MESSAGING');
