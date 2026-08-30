import {
  Controller,
  Get,
  Inject,
  Logger,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import type { Response } from 'express';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import {
  DISCORD_GUILD_MEMBERSHIP,
  type DiscordGuildMembershipPort,
} from '../../domain/ports/discord-guild-membership.port';

/**
 * Link status for the WISPACE frontend — lets the portal show the right UI:
 * - not linked        → "Kết nối Discord" button
 * - linked + in guild → "Đã liên kết ✓" (no hint)
 * - linked, not joined → "Đã liên kết ✓ — Tham gia server Discord để nhận báo cáo…"
 */
@Controller('discord')
@UseGuards(InternalApiKeyGuard)
export class DiscordLinkStatusController {
  private readonly logger = new Logger(DiscordLinkStatusController.name);

  constructor(
    private readonly accountLinkService: DiscordAccountLinkService,
    @Inject(DISCORD_GUILD_MEMBERSHIP)
    private readonly guildMembershipService: DiscordGuildMembershipPort,
  ) {}

  @Get('link-status')
  async getLinkStatus(
    @Query('userId') userIdRaw: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const userId = Number(userIdRaw);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: 'userId must be a positive integer' });
      return;
    }

    const discordUserId =
      await this.accountLinkService.findDiscordIdByUserId(userId);
    if (!discordUserId) {
      res.json({ linked: false, inGuild: false });
      return;
    }

    let inGuild = false;
    try {
      inGuild = await this.guildMembershipService.isMember(discordUserId);
    } catch (error) {
      // Fail open: a transient Discord API error just shows the join hint to
      // everyone — harmless — instead of breaking the portal UI.
      this.logger.warn(
        `link-status guild check failed: ${errorMessage(error)}`,
      );
    }

    res.json({ linked: true, inGuild });
  }
}
