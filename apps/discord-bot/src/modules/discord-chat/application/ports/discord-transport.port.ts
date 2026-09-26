import type { DiscordMentionAllowList } from '../utils/discord-outbound-guard';

/** Button rendered by the transport adapter; the application layer never
 * builds SDK components. */
export interface DiscordOutboundButton {
  customId: string;
  label: string;
  style: 'primary' | 'success' | 'danger';
}

export interface DiscordOutboundMessage {
  content?: string;
  allowedMentions: DiscordMentionAllowList;
  nonce?: string;
  enforceNonce?: boolean;
  embeds?: Array<Record<string, unknown>>;
  components?: Array<Record<string, unknown>>;
}

export interface DiscordDirectMessageResult {
  id: string;
  channelId: string;
}

/**
 * SDK boundary for Discord (#1088). The application service owns retry,
 * rate limiting and delivery journaling; this port only performs the raw
 * provider call so `discord.js` stays in the infrastructure adapter.
 */
export interface DiscordTransportPort {
  sendDirectMessage(
    discordUserId: string,
    message: DiscordOutboundMessage,
  ): Promise<DiscordDirectMessageResult>;

  sendDirectMessageButtons(
    discordUserId: string,
    message: DiscordOutboundMessage,
    buttons: DiscordOutboundButton[],
  ): Promise<DiscordDirectMessageResult>;

  sendTypingIndicator(discordUserId: string): Promise<void>;

  /** Resolves false when the channel exists but is not text-capable. */
  sendChannelMessage(
    channelId: string,
    message: DiscordOutboundMessage,
  ): Promise<boolean>;
}

export const DISCORD_TRANSPORT = Symbol('DISCORD_TRANSPORT');
