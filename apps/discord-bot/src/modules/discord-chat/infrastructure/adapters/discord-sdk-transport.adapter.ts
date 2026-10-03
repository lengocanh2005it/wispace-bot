import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  MessagePayload,
  Routes,
  TextChannel,
} from 'discord.js';
import type { MessageCreateOptions } from 'discord.js';
import type {
  DiscordDirectMessageResult,
  DiscordOutboundButton,
  DiscordOutboundMessage,
  DiscordTransportPort,
} from '../../application/ports/discord-transport.port';
import { DiscordSendTimeoutError } from '../../domain/discord-send-outcome.errors';
import { resolveDiscordSendTimeoutMs } from '../../domain/discord-send-timeout';

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
  private readonly sendTimeoutMs: number;

  constructor(
    private readonly client: Client,
    configService: ConfigService,
  ) {
    this.sendTimeoutMs = resolveDiscordSendTimeoutMs(configService);
  }

  /**
   * Sends one message and attributes a failure to its cause.
   *
   * `discord.js` v14 exposes no per-request signal: `channel.send()` calls
   * `client.rest.post()` with only `{ body, files }`, so a deadline has no
   * path to the request. Reusing `MessagePayload` keeps the library's own body
   * building (content splitting, nonce, embed/component serialization) and
   * swaps only the HTTP call.
   */
  private async postMessage(
    channelId: string,
    message: DiscordOutboundMessage,
    target: Parameters<typeof MessagePayload.create>[0],
  ): Promise<{ id: string }> {
    const { signal, attribute } = this.deadline();
    const payload = MessagePayload.create(
      target,
      toMessageCreateOptions(message),
    ).resolveBody();
    // `resolveFiles` yields `null` for a send with no attachments, and the REST
    // client rejects `null` — only `files` or an absent key is assignable.
    const { body, files } = await payload.resolveFiles();
    const attachments = files ?? undefined;

    try {
      const sent = await this.client.rest.post(
        Routes.channelMessages(channelId),
        {
          body,
          ...(attachments ? { files: attachments } : {}),
          signal,
        },
      );
      return sent as { id: string };
    } catch (error) {
      throw attribute(error);
    }
  }

  /**
   * Builds this send's deadline. Returns the signal to send with plus an
   * attribution function that names the cause when the deadline is what
   * ended the call: `@discordjs/rest` aborts through a private controller
   * with no reason, so the error arrives as a bare `AbortError` that is
   * indistinguishable from any other abort.
   */
  private deadline(): {
    signal: AbortSignal;
    attribute: (error: unknown) => unknown;
  } {
    const deadline = AbortSignal.timeout(this.sendTimeoutMs);
    return {
      signal: deadline,
      attribute: (error: unknown) => {
        if (deadline.aborted) {
          return new DiscordSendTimeoutError(this.sendTimeoutMs);
        }
        return error;
      },
    };
  }

  async sendDirectMessage(
    discordUserId: string,
    message: DiscordOutboundMessage,
  ): Promise<DiscordDirectMessageResult> {
    const user = await this.client.users.fetch(discordUserId);
    const channel = await user.createDM();
    const sent = await this.postMessage(channel.id, message, channel);
    return { id: sent.id, channelId: channel.id };
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
    const channel = await user.createDM();
    const sent = await this.postMessage(
      channel.id,
      { ...message, components: [row as unknown as Record<string, unknown>] },
      channel,
    );
    return { id: sent.id, channelId: channel.id };
  }

  async sendTypingIndicator(discordUserId: string): Promise<void> {
    const user = await this.client.users.fetch(discordUserId);
    const channel = await user.createDM();
    const { signal, attribute } = this.deadline();
    try {
      await this.client.rest.post(Routes.channelTyping(channel.id), { signal });
    } catch (error) {
      throw attribute(error);
    }
  }

  async sendChannelMessage(
    channelId: string,
    message: DiscordOutboundMessage,
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!(channel instanceof TextChannel)) return false;
    await this.postMessage(channel.id, message, channel);
    return true;
  }
}
