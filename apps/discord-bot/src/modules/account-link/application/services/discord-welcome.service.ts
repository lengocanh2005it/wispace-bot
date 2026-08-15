import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { readRewelcomeWindowMs } from '@discord/shared/config/discord-link.config';
import { buildDiscordLinkWelcomeMessage } from '../messages/account-link.messages';
import { DiscordAccountLinkService } from './discord-account-link.service';

/**
 * Welcome-DM delivery with a single dedupe point (#137 items 2+4): sends the
 * welcome only when the mapping says the user has not been welcomed within
 * `DISCORD_REWELCOME_WINDOW_MS`, then marks `last_welcomed_at`. Used by the
 * OAuth callback, `guildMemberAdd` and the link-reconcile cron so every path
 * behaves identically (no duplicate / no missed welcome across races).
 */
@Injectable()
export class DiscordWelcomeService {
  constructor(
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly outboundService: DiscordOutboundService,
    private readonly configService: ConfigService,
  ) {}

  /** Sends the welcome DM (if due) and returns whether it was sent. */
  async welcomeIfDue(
    discordUserId: string,
    displayName?: string,
  ): Promise<boolean> {
    const shouldWelcome = await this.accountLinkService.shouldWelcome(
      discordUserId,
      readRewelcomeWindowMs(this.configService),
    );
    if (!shouldWelcome) {
      return false;
    }

    await this.outboundService.sendMenuButtons(
      discordUserId,
      buildDiscordLinkWelcomeMessage(displayName),
    );
    await this.accountLinkService.markWelcomed(discordUserId);
    return true;
  }
}
