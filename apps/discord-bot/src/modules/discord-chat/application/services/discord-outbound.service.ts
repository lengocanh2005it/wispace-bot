import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  TextChannel,
} from 'discord.js';
import {
  RESCHEDULE_CANCEL_CUSTOM_ID,
  RESCHEDULE_CONFIRM_CUSTOM_ID,
} from '../constants/discord-reschedule.constants';
import {
  MENU_LEARNING_PROGRESS_CUSTOM_ID,
  MENU_UPCOMING_SESSIONS_CUSTOM_ID,
} from '../constants/discord-menu.constants';
import { DiscordDeliveryLogService } from './discord-delivery-log.service';
import { DiscordDeadLetterService } from './discord-dead-letter.service';

const RETRY_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Discord counterpart to Messenger's `MessageSenderPort` — sends by fetching
 * the DM channel from the Discord user id rather than replying inline on the
 * gateway event, so proactive sends (future study-reminder dispatch) can
 * reuse this later.
 */
@Injectable()
export class DiscordOutboundService {
  private readonly logger = new Logger(DiscordOutboundService.name);

  constructor(
    private readonly client: Client,
    @Optional()
    @Inject(DiscordDeliveryLogService)
    private readonly deliveryLog?: DiscordDeliveryLogService,
    @Optional()
    @Inject(DiscordDeadLetterService)
    private readonly deadLetter?: DiscordDeadLetterService,
  ) {}

  async sendText(
    discordUserId: string,
    text: string,
    options?: { skipDeadLetter?: boolean },
  ): Promise<void> {
    const channelId = await this.sendTextAndGetChannelId(
      discordUserId,
      text,
      options,
    );
    if (!channelId) {
      throw new Error(`Discord DM delivery failed for ${discordUserId}`);
    }
  }

  /** Sends a typing indicator to the user's DM channel (fire-and-forget). */
  async sendTyping(discordUserId: string): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      const channel = await user.createDM();
      await channel.sendTyping();
    } catch {
      // typing indicator is best-effort — swallow errors
    }
  }

  /** Sends a DM and returns the DM channel id (used to build deep links). */
  async sendTextAndGetChannelId(
    discordUserId: string,
    text: string,
    options?: { skipDeadLetter?: boolean },
  ): Promise<string | undefined> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const user = await this.client.users.fetch(discordUserId);
        const msg = await user.send(text);
        await this.deliveryLog?.logDelivery({
          externalUserId: discordUserId,
          status: 'SENT',
          messageType: 'chat',
        });
        return msg.channelId;
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);

        if (attempt < RETRY_MAX_ATTEMPTS) {
          const delayMs = RETRY_BASE_DELAY_MS * attempt;
          this.logger.warn(
            `DM send attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed for discordUserId=${discordUserId}, retrying in ${delayMs}ms: ${errorMsg}`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    const errorMsg =
      lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.warn(
      `Failed to send DM to discordUserId=${discordUserId} after ${RETRY_MAX_ATTEMPTS} attempts: ${errorMsg}`,
    );
    await this.deliveryLog?.logDelivery({
      externalUserId: discordUserId,
      status: 'FAILED',
      error: errorMsg,
      messageType: 'chat',
    });
    if (options?.skipDeadLetter !== true) {
      await this.deadLetter?.save({
        externalUserId: discordUserId,
        rawPayload: { discordUserId, text },
        errorMessage: errorMsg,
      });
    }
    return undefined;
  }

  /** Sends a persistent quick-action menu with 3 buttons. Safe to click after bot restarts. */
  async sendMenuButtons(
    discordUserId: string,
    content?: string,
  ): Promise<string | undefined> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(MENU_UPCOMING_SESSIONS_CUSTOM_ID)
          .setLabel('📅 Lịch học sắp tới')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(MENU_LEARNING_PROGRESS_CUSTOM_ID)
          .setLabel('📊 Xem tiến độ')
          .setStyle(ButtonStyle.Primary),
      );
      const msg = await user.send({ content, components: [row] });
      return msg.channelId;
    } catch (error) {
      this.logger.warn(
        `Failed to send menu buttons to discordUserId=${discordUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  /** Sends a text message to a server channel (not a DM). */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel instanceof TextChannel) {
        await channel.send(text);
      } else {
        this.logger.warn(
          `Channel ${channelId} is not a TextChannel — skipping server welcome`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send to channelId=${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Discord counterpart to Messenger's postback confirm/cancel buttons. */
  async sendRescheduleConfirmation(
    discordUserId: string,
    summary: string,
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(RESCHEDULE_CONFIRM_CUSTOM_ID)
          .setLabel('Xác nhận')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(RESCHEDULE_CANCEL_CUSTOM_ID)
          .setLabel('Hủy')
          .setStyle(ButtonStyle.Danger),
      );
      await user.send({ content: summary, components: [row] });
    } catch (error) {
      this.logger.warn(
        `Failed to send reschedule confirmation to discordUserId=${discordUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
