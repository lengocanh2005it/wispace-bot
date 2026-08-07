import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';
import { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { buildDiscordLinkWelcomeMessage } from '../../application/messages/account-link.messages';

@Controller('discord/guild')
@UseGuards(ThrottlerGuard)
export class DiscordGuildController {
  private readonly logger = new Logger(DiscordGuildController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingJoinService: DiscordPendingJoinService,
    private readonly guildMembershipService: DiscordGuildMembershipService,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly outboundService: DiscordOutboundService,
  ) {}

  /**
   * Polled by the frontend every few seconds after user clicks "Tham gia server".
   * Returns { joined: true } once the bot sees the user in the guild.
   * Returns { expired: true } if the pending token is no longer valid.
   */
  @Get('join-status')
  async getJoinStatus(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    const entry = this.pendingJoinService.get(token);
    if (!entry) {
      res.json({ expired: true, joined: false, completed: false });
      return;
    }

    if (entry.completed) {
      res.json({ joined: true, completed: true, expired: false });
      return;
    }

    const joined = await this.guildMembershipService.isMember(
      entry.discordUserId,
    );
    res.json({ joined, completed: false, expired: false });
  }

  /**
   * Called once by the frontend after polling confirms the user joined.
   * Finalises the account link and sends a welcome DM.
   */
  @Post('complete-link')
  async completeLink(
    @Body('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!token) {
      res.status(400).json({ error: 'Missing token' });
      return;
    }

    const entry = this.pendingJoinService.get(token);
    if (!entry) {
      res.status(400).json({ error: 'TOKEN_EXPIRED' });
      return;
    }

    // Already auto-completed by guildMemberAdd — return success with stored dmChannelId
    if (entry.completed) {
      const botUserId =
        this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
      const dmChannelId = entry.dmChannelId;
      this.pendingJoinService.delete(token);
      res.json({
        success: true,
        botUserId,
        dmChannelId,
        discordUsername: entry.discordUsername,
      });
      return;
    }

    // Re-verify membership at completion time
    const joined = await this.guildMembershipService.isMember(
      entry.discordUserId,
    );
    if (!joined) {
      res.status(400).json({ error: 'NOT_IN_GUILD' });
      return;
    }

    try {
      await this.accountLinkService.upsertLink(
        entry.wispaceUserId,
        entry.discordUserId,
      );

      const dmChannelId = await this.outboundService.sendTextAndGetChannelId(
        entry.discordUserId,
        buildDiscordLinkWelcomeMessage(entry.discordUsername),
      );

      this.pendingJoinService.delete(token);

      const botUserId =
        this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
      res.json({
        success: true,
        botUserId,
        dmChannelId,
        discordUsername: entry.discordUsername,
      });
    } catch (error) {
      this.logger.error(
        `complete-link failed for discordUserId=${entry.discordUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  }
}
