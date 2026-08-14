import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { buildDiscordLinkWelcomeMessage } from '../../application/messages/account-link.messages';
import { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';
import { setPendingLinkCookie } from '../cookies/pending-link-cookie';

@Controller('discord/oauth')
@UseGuards(ThrottlerGuard)
export class DiscordOauthController {
  private readonly logger = new Logger(DiscordOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tokenVerifyService: WispaceTokenVerifyService,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly outboundService: DiscordOutboundService,
    private readonly guildMembershipService: DiscordGuildMembershipService,
    private readonly pendingJoinService: DiscordPendingJoinService,
  ) {}

  /**
   * Returns the Discord OAuth2 authorization URL.
   * The `state` param must come from WISPACE's own link-token API.
   */
  @Get('url')
  getOAuthUrl(
    @Query('state') stateOverride: string | undefined,
    @Res() res: Response,
  ): void {
    const clientId = this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
    const redirectUri = this.configService.getOrThrow<string>(
      'DISCORD_OAUTH_REDIRECT_URI',
    );
    const state = stateOverride?.trim() || '';

    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    if (state) url.searchParams.set('state', state);

    res.json({ url: url.toString() });
  }

  /** `state` carries WISPACE's own link token verbatim (WISPACE owns its expiry/usage state). */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') token: string | undefined,
    @Query('error') discordError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (discordError === 'access_denied') {
      this.sendResult(res, { type: 'cancelled' });
      return;
    }

    if (!code || !token) {
      this.sendResult(res, {
        type: 'error',
        message: 'Thiếu code hoặc token.',
      });
      return;
    }

    try {
      const discordUser =
        await this.accountLinkService.exchangeCodeForDiscordUser(code);
      const { id: discordUserId, username: discordUsername } = discordUser;

      const verifyResult = await this.tokenVerifyService.verifyToken(
        token,
        discordUserId,
      );
      if (!verifyResult.valid) {
        this.sendResult(res, {
          type: 'error',
          message: 'Link đã hết hạn hoặc không hợp lệ.',
        });
        return;
      }
      const wispaceUserId = verifyResult.userId;

      // Guild membership check — must join server before account can be linked
      const inGuild = await this.guildMembershipService.isMember(discordUserId);
      if (!inGuild) {
        this.logger.warn(
          `Guild check failed: discordUserId=${maskExternalId(
            discordUserId,
          )} not in guild — issuing pending cookie`,
        );
        const pendingToken = this.pendingJoinService.create(
          discordUserId,
          wispaceUserId,
          discordUsername,
        );
        // Capability travels in an HttpOnly cookie, never in the redirect URL.
        setPendingLinkCookie(res, pendingToken);
        this.sendResult(res, {
          type: 'pending',
          discordUsername,
        });
        return;
      }

      await this.accountLinkService.upsertLink(wispaceUserId, discordUserId);

      const dmChannelId = await this.outboundService.sendMenuButtons(
        discordUserId,
        buildDiscordLinkWelcomeMessage(discordUsername),
      );
      const botUserId =
        this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
      this.sendResult(res, {
        type: 'success',
        botUserId,
        dmChannelId,
        discordUsername,
      });
    } catch (error) {
      this.logger.error(
        `Discord OAuth callback failed: ${errorMessage(error)}`,
      );
      this.sendResult(res, {
        type: 'error',
        message: 'Có lỗi xảy ra, vui lòng thử lại.',
      });
    }
  }

  private sendResult(
    res: Response,
    result:
      | {
          type: 'success';
          botUserId: string;
          dmChannelId?: string;
          discordUsername: string;
        }
      | { type: 'pending'; discordUsername: string }
      | { type: 'error'; message: string }
      | { type: 'cancelled' },
  ): void {
    const frontendUrl = this.configService.get<string>(
      'DISCORD_OAUTH_FRONTEND_CALLBACK_URL',
    );
    const inviteUrl =
      this.configService.get<string>('DISCORD_INVITE_URL') ?? '';

    // Never leak the query string (or any secret) through referrers of the
    // linking flow — the pending capability is cookie-bound server-side.
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (frontendUrl) {
      const url = new URL(frontendUrl);
      if (result.type === 'cancelled') {
        url.searchParams.set('cancelled', '1');
      } else if (result.type === 'error') {
        url.searchParams.set('error', result.message);
      } else if (result.type === 'pending') {
        url.searchParams.set('discordUsername', result.discordUsername);
        if (inviteUrl) url.searchParams.set('inviteUrl', inviteUrl);
      } else {
        if (result.botUserId)
          url.searchParams.set('botUserId', result.botUserId);
        if (result.dmChannelId)
          url.searchParams.set('dmChannelId', result.dmChannelId);
        if (result.discordUsername)
          url.searchParams.set('discordUsername', result.discordUsername);
      }
      res.redirect(url.toString());
      return;
    }

    this.logger.warn('DISCORD_OAUTH_FRONTEND_CALLBACK_URL is not set');
    res
      .status(400)
      .json({ error: 'OAuth frontend callback URL not configured' });
  }
}
