import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import { WispaceDiscordTokenVerifyService } from '../../infrastructure/wispace/wispace-discord-token-verify.service';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { buildDiscordLinkWelcomeMessage } from '../../application/messages/account-link.messages';
import { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';
import { DiscordPendingJoinService } from '../../application/services/discord-pending-join.service';

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );

@Controller('discord/oauth')
export class DiscordOauthController {
  private readonly logger = new Logger(DiscordOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tokenVerifyService: WispaceDiscordTokenVerifyService,
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
          `Guild check failed: discordUserId=${discordUserId} not in guild — issuing pending token`,
        );
        const pendingToken = this.pendingJoinService.create(
          discordUserId,
          wispaceUserId,
          discordUsername,
        );
        this.sendResult(res, {
          type: 'pending',
          pendingToken,
          discordUsername,
        });
        return;
      }

      await this.accountLinkService.upsertLink(wispaceUserId, discordUserId);

      const dmChannelId = await this.outboundService.sendTextAndGetChannelId(
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
        `Discord OAuth callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      | { type: 'pending'; pendingToken: string; discordUsername: string }
      | { type: 'error'; message: string }
      | { type: 'cancelled' },
  ): void {
    const frontendUrl = this.configService.get<string>(
      'DISCORD_OAUTH_FRONTEND_CALLBACK_URL',
    );
    const inviteUrl =
      this.configService.get<string>('DISCORD_INVITE_URL') ?? '';

    if (frontendUrl) {
      const url = new URL(frontendUrl);
      if (result.type === 'cancelled') {
        url.searchParams.set('cancelled', '1');
      } else if (result.type === 'error') {
        url.searchParams.set('error', result.message);
      } else if (result.type === 'pending') {
        url.searchParams.set('pendingToken', result.pendingToken);
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

    // Inline fallback HTML (no frontend URL configured)
    if (result.type === 'cancelled') {
      res.status(200).type('html').send(`
        <!doctype html><html lang="vi"><head><meta charset="utf-8">
        <title>Đã hủy</title></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:3rem;">
          <h2>Đã hủy liên kết</h2>
          <p>Bạn có thể thử lại bất cứ lúc nào.</p>
        </body></html>
      `);
    } else if (result.type === 'success') {
      res.status(200).type('html').send(`
        <!doctype html><html lang="vi"><head><meta charset="utf-8">
        <title>Kết nối thành công</title></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:3rem;">
          <h2>Kết nối thành công</h2>
          <p>Tài khoản Discord <strong>${escapeHtml(result.discordUsername)}</strong> đã liên kết với WISPACE.</p>
        </body></html>
      `);
    } else if (result.type === 'pending') {
      res.status(200).type('html').send(`
        <!doctype html><html lang="vi"><head><meta charset="utf-8">
        <title>Tham gia server trước</title></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:3rem;">
          <h2>Bạn chưa trong server WISPACE</h2>
          <p>Tham gia server rồi quay lại để hoàn tất liên kết.</p>
          ${inviteUrl ? `<a href="${inviteUrl}">Tham gia server →</a>` : ''}
        </body></html>
      `);
    } else {
      res.status(400).type('html').send(`
        <!doctype html><html lang="vi"><head><meta charset="utf-8">
        <title>Kết nối thất bại</title></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:3rem;">
          <h2>Kết nối thất bại</h2><p>${result.message}</p>
        </body></html>
      `);
    }
  }
}
