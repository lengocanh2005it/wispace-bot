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
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import {
  ZaloLinkCompletionService,
  ZaloLinkTokenRejectedError,
} from '../../application/services/zalo-link-completion.service';

const OAUTH_STATE_COOKIE = '__Host-zalo_oauth_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — matches state TTL

@Controller('zalo/oauth')
@UseGuards(ThrottlerGuard)
export class ZaloOauthController {
  private readonly logger = new Logger(ZaloOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly oauthStateService: ZaloOauthStateService,
    private readonly completionService: ZaloLinkCompletionService,
  ) {}

  /** `token` is WISPACE's own link token, passed through as-is (WISPACE owns its expiry/usage state). */
  @Get('authorize')
  async authorize(
    @Query('token') linkToken: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const normalizedLinkToken = linkToken?.trim();
    if (!normalizedLinkToken || normalizedLinkToken.length > 512) {
      res.status(400).json({
        success: false,
        message: 'Thiếu hoặc không hợp lệ link token.',
      });
      return;
    }

    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const redirectUri = this.configService.getOrThrow<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );

    const { codeVerifier, codeChallenge } =
      this.accountLinkService.buildPkcePair();
    const state = await this.oauthStateService.create(
      codeVerifier,
      normalizedLinkToken,
    );

    const url = new URL('https://oauth.zaloapp.com/v4/permission');
    url.searchParams.set('app_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('state', state);

    // ponytail: Cache-Control not in Helmet v8 — prevent browser/proxy caching of token-bearing 302 redirect
    res.setHeader('Cache-Control', 'no-store');
    // Bind OAuth state to the initiating browser session (#348)
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      // __Host- cookies are browser-enforced to Secure, no Domain, and Path=/
      sameSite: 'lax',
      path: '/',
      maxAge: OAUTH_STATE_TTL_MS,
    });
    res.redirect(url.toString());
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') rawState: string | undefined,
    @Res() res: Response,
    @Req() req: { headers: { cookie?: string } },
  ): Promise<void> {
    if (!code || !rawState) {
      res.json({ success: false, message: 'Thiếu code hoặc state.' });
      return;
    }

    // Bind OAuth state to the initiating browser session (#348)
    const cookieState = parseCookieHeader(req.headers.cookie)[
      OAUTH_STATE_COOKIE
    ];
    if (!cookieState || cookieState !== rawState) {
      this.logger.warn(
        'Zalo OAuth callback: state mismatch — possible cross-browser or forwarded URL',
      );
      res.json({
        success: false,
        message: 'Phiên liên kết không hợp lệ, vui lòng thử lại.',
      });
      return;
    }
    // Clear the cookie after validation — single-use
    res.clearCookie(OAUTH_STATE_COOKIE);

    const consumed = await this.oauthStateService.consume(rawState);
    if (!consumed) {
      res.json({
        success: false,
        message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
      });
      return;
    }

    try {
      await this.completionService.completeLink(
        code,
        consumed.codeVerifier,
        consumed.linkToken,
      );

      res.json({ success: true });
    } catch (error) {
      if (error instanceof ZaloLinkTokenRejectedError) {
        res.json({
          success: false,
          message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
        });
        return;
      }
      this.logger.error(`Zalo OAuth callback failed: ${errorMessage(error)}`);
      res.json({ success: false, message: 'Có lỗi xảy ra, vui lòng thử lại.' });
    }
  }
}
