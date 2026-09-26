import { Injectable } from '@nestjs/common';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  TextChannel,
} from 'discord.js';
import type { MessageCreateOptions } from 'discord.js';
import type {
  DiscordDirectMessageResult,
  DiscordOutboundButton,
  DiscordOutboundMessage,
  DiscordTransportPort,
} from '../../application/ports/discord-transport.port';

const BUTTON_STYLES: Record<DiscordOutboundButton['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function toMessageCreateOptions(
  message: DiscordOutboundMessage,
): MessageCreateOptions {
  return {
    ...(message.content !== undefined ? { content: message.content } : {}),
    allowedMentions: message.allowedMentions,
    ...(message.nonce !== undefined ? { nonce: message.nonce } : {}),
    ...(message.enforceNonce !== undefined
      ? { enforceNonce: message.enforceNonce }
      : {}),
    ...(message.embeds !== undefined ? { embeds: message.embeds } : {}),
    ...(message.components !== undefined
      ? { components: message.components }
      : {}),
  } as MessageCreateOptions;
}

/** `discord.js` adapter for {@link DiscordTransportPort}. */
@Injectable()
export class DiscordSdkTransportAdapter implements DiscordTransportPort {
  constructor(private readonly client: Client) {}

  async sendDirectMessage(
    discordUserId: string,
    message: DiscordOutboundMessage,
  ): Promise<DiscordDirectMessageResult> {
    const user = await this.client.users.fetch(discordUserId);
    const sent = await user.send(toMessageCreateOptions(message));
    return { id: sent.id, channelId: sent.channelId };
  }

  async sendDirectMessageButtons(
    discordUserId: string,
    message: DiscordOutboundMessage,
    buttons: DiscordOutboundButton[],
  ): Promise<DiscordDirectMessageResult> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...buttons.map((button) =>
        new ButtonBuilder()
          .setCustomId(button.customId)
          .setLabel(button.label)
          .setStyle(BUTTON_STYLES[button.style]),
      ),
    );
    const user = await this.client.users.fetch(discordUserId);
    const sent = await user.send({
      ...toMessageCreateOptions(message),
      components: [row],
    } as MessageCreateOptions);
    return { id: sent.id, channelId: sent.channelId };
  }

  async sendTypingIndicator(discordUserId: string): Promise<void> {
    const user = await this.client.users.fetch(discordUserId);
    const channel = await user.createDM();
    await channel.sendTyping();
  }

  async sendChannelMessage(
    channelId: string,
    message: DiscordOutboundMessage,
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!(channel instanceof TextChannel)) return false;
    await channel.send(toMessageCreateOptions(message));
    return true;
  }
}
