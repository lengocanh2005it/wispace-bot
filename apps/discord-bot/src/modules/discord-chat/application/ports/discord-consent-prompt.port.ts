/**
 * The once-per-link consent explainer and the opt-out footer it pairs with
 * (#596). `discord-chat` owns the decision to send; the account-link feature
 * owns the atomic claim, so the two meet at this port and the composition root
 * binds the account-link service to the token below.
 */
export interface DiscordConsentPromptPort {
  /**
   * Claims and delivers the explainer at most once per Discord account. The
   * caller supplies the transport; a failed send releases the claim so the next
   * guild-join event can retry. Resolves false when the claim was lost.
   */
  sendConsentExplainerIfDue(
    discordUserId: string,
    send: (text: string) => Promise<void>,
  ): Promise<boolean>;
  /**
   * Marks the one-time opt-out footer as already delivered, so an explicit
   * report opt-in never receives it.
   */
  suppressOptOutNotice(discordUserId: string): Promise<void>;
}

export const DISCORD_CONSENT_PROMPT = Symbol('DISCORD_CONSENT_PROMPT');
