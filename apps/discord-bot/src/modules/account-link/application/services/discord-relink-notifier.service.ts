import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { buildDiscordRelinkNoticeMessage } from '../messages/account-link.messages';

/**
 * Relink-overwrite notification (#137 item 5): when a Discord id is (re)mapped
 * to a different WISPACE user, the previously-linked user silently loses the
 * link — warn-log it and DM the account holder. Shared by the OAuth callback
 * and the link-reconcile cron so both paths behave identically.
 */
@Injectable()
export class DiscordRelinkNotifier {
  private readonly logger = new Logger(DiscordRelinkNotifier.name);

  constructor(private readonly outboundService: DiscordOutboundService) {}

  async notify(
    discordUserId: string,
    previousUserId: number | undefined,
  ): Promise<void> {
    this.logger.warn(
      `Relink displaced previous userId=${maskExternalId(
        previousUserId ?? 0,
      )} for discordUserId=${maskExternalId(discordUserId)}`,
    );

    await this.outboundService
      .sendText(discordUserId, buildDiscordRelinkNoticeMessage())
      .catch((error: unknown) => {
        this.logger.warn(
          `Discord relink notice DM failed for discordUserId=${maskExternalId(
            discordUserId,
          )}: ${errorMessage(error)}`,
        );
      });
  }
}
