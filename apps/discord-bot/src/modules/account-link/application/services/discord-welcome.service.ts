import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotMetricsService } from '@wispace/bot-metrics';
import { buildGreetingMessage } from '@wispace/bot-common/messages';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import {
  readRewelcomeWindowMs,
  readWelcomeClaimMs,
} from '@discord/shared/config/discord-link.config';
import { buildDiscordLinkWelcomeMessage } from '../messages/account-link.messages';
import {
  DISCORD_WELCOME_RECORD_REPOSITORY,
  type DiscordWelcomeRecordRepositoryPort,
  type WelcomeSource,
} from '../../domain/ports/discord-welcome-record.repository.port';

/**
 * Welcome-DM delivery with a single atomic dedupe point keyed by Discord
 * user id alone (`discord_welcome_records`, #231): `tryClaimWelcome` reserves
 * the welcome slot in one conditional upsert (#159) — a concurrent OAuth
 * callback / `guildMemberAdd` loses the claim instead of sending a duplicate
 * DM. The record is marked only when Discord acknowledged the DM (#232 — a
 * failed send leaves the claim to expire and the next join/callback/reconcile
 * event retries). Both the organic and the linked path share the same
 * record, so a user welcomed organically is not welcomed again at link time
 * within the window (#233).
 */
export type WelcomeDeliveryOutcome = 'sent' | 'skipped' | 'error';

@Injectable()
export class DiscordWelcomeService {
  constructor(
    @Inject(DISCORD_WELCOME_RECORD_REPOSITORY)
    private readonly welcomeRecords: DiscordWelcomeRecordRepositoryPort,
    private readonly outboundService: DiscordOutboundService,
    private readonly configService: ConfigService,
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  /** Sends the linked welcome DM (if due) and reports the delivery outcome. */
  async welcomeIfDue(
    discordUserId: string,
    displayName?: string,
  ): Promise<WelcomeDeliveryOutcome> {
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
  ): Promise<WelcomeDeliveryOutcome> {
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
  ): Promise<WelcomeDeliveryOutcome> {
    const windowMs = readRewelcomeWindowMs(this.configService);
    const claimMs = readWelcomeClaimMs(this.configService);
    // Atomic claim (#159): the winner (this call, under concurrency) proceeds
    // to send; a concurrent OAuth callback / `guildMemberAdd` loses the claim
    // and is skipped instead of sending a duplicate DM.
    if (
      !(await this.welcomeRecords.tryClaimWelcome(
        discordUserId,
        windowMs,
        claimMs,
      ))
    ) {
      this.metrics?.incWelcomeAttempt('skipped');
      return 'skipped';
    }

    const delivered = await this.outboundService.sendMenuButtons(
      discordUserId,
      message,
    );
    if (!delivered) {
      // Never mark "welcomed" on a failed send — the claim expires and the
      // next join/callback/reconcile event retries (#232/#159).
      this.metrics?.incWelcomeAttempt('error');
      return 'error';
    }

    await this.welcomeRecords.markWelcomed(discordUserId, source);
    this.metrics?.incWelcomeAttempt('success');
    return 'sent';
  }
}
