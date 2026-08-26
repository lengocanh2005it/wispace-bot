import {
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { errorMessage, parseCookieHeader } from '@wispace/bot-common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordLinkCompletionService } from '../../application/services/discord-link-completion.service';
import { DiscordOauthStateService } from '../../application/services/discord-oauth-state.service';

const OAUTH_STATE_COOKIE = 'discord_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches state TTL

/**
 * Thin presentation layer for Discord OAuth — all business logic (verify,
 * mapping commit, welcome, relink notice) lives in `DiscordLinkCompletionService`;
 * this controller only builds URLs and maps outcomes to redirects.
 */
@Controller('discord/oauth')
@UseGuards(ThrottlerGuard)
export class DiscordOauthController {
  private readonly logger = new Logger(DiscordOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly completionService: DiscordLinkCompletionService,
    private readonly stateService: DiscordOauthStateService,
  ) {}

  /**
   * Returns the Discord OAuth2 authorization URL with CSRF state binding.
   * The `state` param is a WISPACE link token; we generate a random nonce,
   * store it server-side, and pass the nonce to Discord's OAuth flow.
   */
  @Get('url')
  async getOAuthUrl(
    @Query('state') linkToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const clientId = this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
    const redirectUri = this.configService.getOrThrow<string>(
      'DISCORD_OAUTH_REDIRECT_URI',
    );

    if (!linkToken?.trim()) {
      res.json({ url: '' });
      return;
    }

    const state = await this.stateService.create(linkToken.trim());

    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);

    // ponytail: Cache-Control not in Helmet v8 — prevent browser/proxy caching of token-bearing response
    res.setHeader('Cache-Control', 'no-store');
    // Bind OAuth state to the initiating browser session (#348)
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: OAUTH_STATE_TTL_MS,
    });
    res.json({ url: url.toString() });
  }

  /**
   * Callback receives the random state nonce from Discord, consumes it
   * server-side to retrieve the WISPACE link token, then completes the link.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') discordError: string | undefined,
    @Res() res: Response,
    @Req() req: { headers: { cookie?: string } },
  ): Promise<void> {
    if (discordError === 'access_denied') {
      this.sendResult(res, 'cancelled');
      return;
    }

    if (!code || !state) {
      this.sendResult(res, 'error');
      return;
    }

    // Bind OAuth state to the initiating browser session (#348)
    const cookieState = parseCookieHeader(req.headers.cookie)[
      OAUTH_STATE_COOKIE
    ];
    if (!cookieState || cookieState !== state) {
      this.logger.warn(
        'Discord OAuth callback: state mismatch — possible cross-browser or forwarded URL',
      );
      this.sendResult(res, 'error');
      return;
    }
    // Clear the cookie after validation — single-use
    res.clearCookie(OAUTH_STATE_COOKIE);

    const consumed = await this.stateService.consume(state);
    if (!consumed) {
      this.logger.warn('Discord OAuth callback: invalid or expired state');
      this.sendResult(res, 'error');
      return;
    }

    try {
      const outcome = await this.completionService.completeLink(
        code,
        consumed.linkToken,
      );
      this.sendResult(res, outcome === 'success' ? 'success' : 'not-in-guild');
    } catch (error) {
      this.logger.error(
        `Discord OAuth callback failed: ${errorMessage(error)}`,
      );
      this.sendResult(res, 'error');
    }
  }

  private sendResult(
    res: Response,
    type: 'success' | 'not-in-guild' | 'error' | 'cancelled',
  ): void {
    const landingUrl = this.configService.getOrThrow<string>(
      'DISCORD_LINK_LANDING_URL',
    );
    const inviteUrl = this.configService.get<string>('DISCORD_INVITE_URL');

    const target =
      type === 'not-in-guild' ? inviteUrl || landingUrl : landingUrl;

    // No secrets in the URL — the frontend needs nothing from us (WISPACE
    // shows the link state itself); restrict referrers of the linking flow.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(target);
  }
}
