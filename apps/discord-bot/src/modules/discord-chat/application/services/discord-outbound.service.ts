import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import { BotMetricsService } from '@wispace/bot-metrics';
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
  DeliveryLogService,
  PlatformDeadLetterService,
} from '@wispace/database';
import {
  MENU_LEARNING_PROGRESS_CUSTOM_ID,
  MENU_UPCOMING_SESSIONS_CUSTOM_ID,
} from '../constants/discord-menu.constants';
import { withRetry } from '@wispace/wispace-client';

const DM_FAILURE_REASON_SEND = 'dm_send_error';
const DM_FAILURE_REASON_MENU = 'menu_send_error';
const DM_FAILURE_REASON_RESCHEDULE = 'reschedule_send_error';
/** Network/unknown delivery outcome — the provider may have accepted the message (#156). */
const DM_FAILURE_REASON_AMBIGUOUS = 'dm_send_ambiguous';
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isDiscordNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * Retry predicate for Discord DM sends (#156): retry only rate limits (429),
 * server errors (5xx) and known network-level failures. Never retry known 4xx
 * (auth/validation — permanent), unknown errors, or cancellations.
 */
export function isDiscordRetryableError(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return isDiscordNetworkError(error);
}

/** True when the error carries no delivery verdict — the provider may have
 * accepted the message before the failure (ambiguous outcome, #156). */
export function isAmbiguousDeliveryError(error: unknown): boolean {
  if (error instanceof DiscordDeliveryFailureError) {
    return error.ambiguousDelivery;
  }
  if (isAbortError(error)) {
    return (error as { name?: unknown } | null)?.name === 'TimeoutError';
  }
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== 'number' && isDiscordNetworkError(error);
}

export class DiscordDeliveryFailureError extends Error {
  constructor(
    message: string,
    readonly ambiguousDelivery: boolean,
  ) {
    super(message);
    this.name = 'DiscordDeliveryFailureError';
  }
}

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
    @Inject(DeliveryLogService)
    private readonly deliveryLog?: DeliveryLogService,
    @Optional()
    @Inject(PlatformDeadLetterService)
    private readonly deadLetter?: PlatformDeadLetterService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  isAmbiguousDeliveryError(error: unknown): boolean {
    return isAmbiguousDeliveryError(error);
  }

  async sendText(
    discordUserId: string,
    text: string,
    options?: {
      skipDeadLetter?: boolean;
      nonce?: string;
      deliveryKey?: string;
      clarification?: boolean;
    },
  ): Promise<void> {
    const channelId = await this.sendTextAndGetChannelId(
      discordUserId,
      text,
      options,
    );
    if (!channelId) {
      throw new Error(
        `Discord DM delivery failed for ${maskExternalId(discordUserId)}`,
      );
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
    options?: {
      skipDeadLetter?: boolean;
      nonce?: string;
      deliveryKey?: string;
      clarification?: boolean;
    },
  ): Promise<string | undefined> {
    const nonce =
      options?.nonce ??
      (options?.deliveryKey
        ? this.toDiscordNonce(options.deliveryKey)
        : randomUUID().replaceAll('-', '').slice(0, 25));
    const result = await this.sendCore(discordUserId, text, nonce);
    if (result.ok) {
      await this.deliveryLog?.logDelivery({
        externalUserId: discordUserId,
        status: 'SENT',
        messageType: 'chat',
      });
      return result.channelId;
    }

    const errorMsg = result.error;
    this.logger.warn(
      `Failed to send DM to discordUserId=${maskExternalId(
        discordUserId,
      )} after retries: ${errorMsg}`,
    );
    if (result.ambiguous) {
      this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_AMBIGUOUS);
    } else {
      this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_SEND);
    }
    await this.deliveryLog?.logDelivery({
      externalUserId: discordUserId,
      status: 'FAILED',
      error: errorMsg,
      messageType: 'chat',
    });
    if (
      options?.skipDeadLetter !== true &&
      (options?.clarification !== true || !result.ambiguous)
    ) {
      const persisted = await this.deadLetter?.save({
        externalUserId: discordUserId,
        rawPayload: { discordUserId, text },
        errorMessage: errorMsg,
        direction: 'outbound',
        ...(options?.deliveryKey ? { deliveryKey: options.deliveryKey } : {}),
      });
      if (persisted === false) {
        this.logger.error(
          `No durable recovery record for failed DM to discordUserId=${maskExternalId(
            discordUserId,
          )} — dead-letter persistence failed`,
        );
      }
    }
    throw new DiscordDeliveryFailureError(
      `Discord DM delivery failed for ${maskExternalId(discordUserId)}`,
      result.ambiguous,
    );
  }

  private toDiscordNonce(deliveryKey: string): string {
    return createHash('sha256').update(deliveryKey).digest('hex').slice(0, 25);
  }

  /**
   * Crash-safe dead-letter replay send (#291): reuses the persisted delivery
   * key as the Discord nonce so the provider deduplicates retries, and returns
   * the delivery outcome instead of dead-lettering again. Never retries on a
   * known 4xx (permanent) — only ambiguous outcomes are replayed by the cron.
   */
  async sendTextForRetry(
    discordUserId: string,
    text: string,
    deliveryKey: string,
  ): Promise<'sent' | 'ambiguous' | 'not_sent'> {
    const result = await this.sendCore(
      discordUserId,
      text,
      this.toDiscordNonce(deliveryKey),
    );
    if (result.ok) {
      await this.deliveryLog?.logDelivery({
        externalUserId: discordUserId,
        status: 'SENT',
        messageType: 'chat',
      });
      return 'sent';
    }
    this.logger.warn(
      `Dead-letter replay failed for discordUserId=${maskExternalId(
        discordUserId,
      )}: ${result.error}`,
    );
    await this.deliveryLog?.logDelivery({
      externalUserId: discordUserId,
      status: 'FAILED',
      error: result.error,
      messageType: 'chat',
    });
    return result.ambiguous ? 'ambiguous' : 'not_sent';
  }

  private async sendCore(
    discordUserId: string,
    text: string,
    nonce: string,
  ): Promise<
    | { ok: true; channelId: string }
    | { ok: false; error: string; ambiguous: boolean }
  > {
    let ambiguousDeliveryRecorded = false;
    try {
      const msg = await withRetry(
        async () => {
          const user = await this.client.users.fetch(discordUserId);
          return user.send({ content: text, nonce, enforceNonce: true });
        },
        {
          maxRetries: 1,
          baseDelayMs: 1_000,
          shouldRetry: isDiscordRetryableError,
          onRetry: (attempt, maxRetries, error) => {
            // Network/unknown failures have no delivery verdict — the
            // provider may have accepted the first attempt (#156).
            if (isAmbiguousDeliveryError(error)) {
              this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_AMBIGUOUS);
              ambiguousDeliveryRecorded = true;
            }
            const errorMsg = maskExternalIdInText(
              errorMessage(error),
              discordUserId,
            );
            this.logger.warn(
              `DM send attempt ${attempt}/${maxRetries + 1} failed for discordUserId=${maskExternalId(discordUserId)}, retrying: ${errorMsg}`,
            );
          },
        },
      );
      return { ok: true, channelId: msg.channelId };
    } catch (error) {
      const errorMsg = maskExternalIdInText(errorMessage(error), discordUserId);
      const ambiguous =
        ambiguousDeliveryRecorded || isAmbiguousDeliveryError(error);
      if (ambiguous) {
        this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_AMBIGUOUS);
      }
      return { ok: false, error: errorMsg, ambiguous };
    }
  }

  /**
   * Sends a persistent quick-action menu with 3 buttons. Safe to click after
   * bot restarts. Returns true only when Discord acknowledged the send — a
   * privacy-blocked DM or API error returns false (the caller decides
   * whether to treat the welcome as delivered, #232).
   */
  async sendMenuButtons(
    discordUserId: string,
    content?: string,
  ): Promise<boolean> {
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
      await user.send({ content, components: [row] });
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to send menu buttons to discordUserId=${maskExternalId(
          discordUserId,
        )}: ${maskExternalIdInText(errorMessage(error), discordUserId)}`,
      );
      this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_MENU);
      return false;
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
          `Channel ${maskExternalId(channelId)} is not a TextChannel — skipping server welcome`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send to channelId=${maskExternalId(
          channelId,
        )}: ${maskExternalIdInText(errorMessage(error), channelId)}`,
      );
    }
  }

  /** Discord counterpart to Messenger's postback confirm/cancel buttons. */
  async sendRescheduleConfirmation(
    discordUserId: string,
    summary: string,
    confirmationToken?: string,
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            confirmationToken
              ? `${RESCHEDULE_CONFIRM_CUSTOM_ID}:${confirmationToken}`
              : RESCHEDULE_CONFIRM_CUSTOM_ID,
          )
          .setLabel('Xác nhận')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(
            confirmationToken
              ? `${RESCHEDULE_CANCEL_CUSTOM_ID}:${confirmationToken}`
              : RESCHEDULE_CANCEL_CUSTOM_ID,
          )
          .setLabel('Hủy')
          .setStyle(ButtonStyle.Danger),
      );
      await user.send({ content: summary, components: [row] });
    } catch (error) {
      this.logger.warn(
        `Failed to send reschedule confirmation to discordUserId=${maskExternalId(
          discordUserId,
        )}: ${maskExternalIdInText(errorMessage(error), discordUserId)}`,
      );
      this.metrics?.incDmDeliveryFailure(DM_FAILURE_REASON_RESCHEDULE);
    }
  }
}
