import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ZaloAccountLinkService } from '../../application/services/zalo-account-link.service';
import { ZaloOauthStateService } from '../../application/services/zalo-oauth-state.service';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { ZaloOutboundService } from '@zalo/modules/zalo-chat/application/services/zalo-outbound.service';

const LINK_WELCOME_MESSAGE =
  'Tài khoản WISPACE của bạn đã liên kết thành công với Zalo! 🎉';

@Controller('zalo/oauth')
@UseGuards(ThrottlerGuard)
export class ZaloOauthController {
  private readonly logger = new Logger(ZaloOauthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly oauthStateService: ZaloOauthStateService,
    private readonly tokenVerifyService: WispaceTokenVerifyService,
    private readonly outboundService: ZaloOutboundService,
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

    res.redirect(url.toString());
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') rawState: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !rawState) {
      res.json({ success: false, message: 'Thiếu code hoặc state.' });
      return;
    }

    const consumed = await this.oauthStateService.consume(rawState);
    if (!consumed) {
      res.json({
        success: false,
        message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
      });
      return;
    }

    try {
      const zaloUser = await this.accountLinkService.exchangeCodeForZaloUser(
        code,
        consumed.codeVerifier,
      );

      const verifyResult = await this.tokenVerifyService.verifyToken(
        consumed.linkToken,
        zaloUser.id,
      );
      if (!verifyResult.valid) {
        res.json({
          success: false,
          message: 'Link đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
        });
        return;
      }

      await this.accountLinkService.upsertLink(
        verifyResult.userId,
        zaloUser.id,
      );
      await this.outboundService.sendText(zaloUser.id, LINK_WELCOME_MESSAGE);

      res.json({ success: true });
    } catch (error) {
      this.logger.error(
        `Zalo OAuth callback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      res.json({ success: false, message: 'Có lỗi xảy ra, vui lòng thử lại.' });
    }
  }
}
