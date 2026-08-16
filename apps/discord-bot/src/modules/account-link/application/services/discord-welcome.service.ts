import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotMetricsService } from '@wispace/bot-metrics';
import { buildGreetingMessage } from '@wispace/bot-common';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { readRewelcomeWindowMs } from '@discord/shared/config/discord-link.config';
import { buildDiscordLinkWelcomeMessage } from '../messages/account-link.messages';
import {
  DISCORD_WELCOME_RECORD_REPOSITORY,
  type DiscordWelcomeRecordRepositoryPort,
  type WelcomeSource,
} from '../../domain/ports/discord-welcome-record.repository.port';

/**
 * Welcome-DM delivery with a single dedupe point keyed by Discord user id
 * alone (`discord_welcome_records`, #231): sends the welcome only when the
 * record says the user has not been welcomed within
 * `DISCORD_REWELCOME_WINDOW_MS`, and marks it only when Discord acknowledged
 * the DM (#232 — a failed send leaves the user unwelcomed so the next
 * join/callback/reconcile event retries). Both the organic and the linked
 * path share the same record, so a user welcomed organically is not welcomed
 * again at link time within the window (#233).
 */
@Injectable()
export class DiscordWelcomeService {
  private readonly logger = new Logger(DiscordWelcomeService.name);

  constructor(
    @Inject(DISCORD_WELCOME_RECORD_REPOSITORY)
    private readonly welcomeRecords: DiscordWelcomeRecordRepositoryPort,
    private readonly outboundService: DiscordOutboundService,
    private readonly configService: ConfigService,
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  /** Sends the linked welcome DM (if due) and returns whether it was sent. */
  async welcomeIfDue(
    discordUserId: string,
    displayName?: string,
  ): Promise<boolean> {
    return this.sendIfDue(
      discordUserId,
      displayName,
      'linked',
      buildDiscordLinkWelcomeMessage(displayName),
    );
  }

  /**
   * Sends the organic welcome DM (unlinked user joining the guild, #231) with
   * the same dedupe semantics as the linked path. Callers skip it when a
   * fresh verify intent means the link callback is in flight.
   */
  async sendOrganicWelcomeIfDue(
    discordUserId: string,
    displayName?: string,
  ): Promise<boolean> {
    return this.sendIfDue(
      discordUserId,
      displayName,
      'organic',
      buildGreetingMessage(displayName),
    );
  }

  private async sendIfDue(
    discordUserId: string,
    displayName: string | undefined,
    source: WelcomeSource,
    message: string,
  ): Promise<boolean> {
    const windowMs = readRewelcomeWindowMs(this.configService);
    if (!(await this.welcomeRecords.shouldWelcome(discordUserId, windowMs))) {
      this.metrics?.incWelcomeAttempt('skipped');
      return false;
    }

    const delivered = await this.outboundService.sendMenuButtons(
      discordUserId,
      message,
    );
    if (!delivered) {
      // Never mark "welcomed" on a failed send — the next join/callback/
      // reconcile event retries (#232).
      this.metrics?.incWelcomeAttempt('error');
      return false;
    }

    await this.welcomeRecords.markWelcomed(discordUserId, source);
    this.metrics?.incWelcomeAttempt('success');
    return true;
  }
}
