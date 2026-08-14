import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { buildDiscordLinkWelcomeMessage } from '../../application/messages/account-link.messages';
import { DiscordGuildMembershipService } from '../../application/services/discord-guild-membership.service';

const UPSERT_MAX_ATTEMPTS = 3;
const UPSERT_BASE_BACKOFF_MS = 500;

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

  /**
   * `state` carries WISPACE's own link token verbatim (WISPACE owns its expiry/usage state).
   *
   * Linking commits IMMEDIATELY after token verification — it does NOT depend
   * on guild membership or any join event. Joining the server only controls
   * when the welcome DM can be delivered (Discord DM needs a shared guild);
   * the welcome is re-sent on `guildMemberAdd` for already-linked users.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') token: string | undefined,
    @Query('error') discordError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (discordError === 'access_denied') {
      this.sendResult(res, 'cancelled');
      return;
    }

    if (!code || !token) {
      this.sendResult(res, 'error');
      return;
    }

    try {
      const discordUser =
        await this.accountLinkService.exchangeCodeForDiscordUser(code);

      const verifyResult = await this.tokenVerifyService.verifyToken(
        token,
        discordUser.id,
      );
      if (!verifyResult.valid) {
        this.sendResult(res, 'error');
        return;
      }

      // WISPACE has already consumed the link token (single-use) — the mapping
      // MUST be committed now, or WISPACE shows "linked" while the bot has no
      // mapping. Retry transient DB failures; a permanent failure surfaces as
      // an error redirect and the user retries with a fresh token.
      await this.upsertLinkWithRetry(verifyResult.userId, discordUser.id);

      const inGuild = await this.guildMembershipService.isMember(
        discordUser.id,
      );
      if (inGuild) {
        await this.outboundService.sendMenuButtons(
          discordUser.id,
          buildDiscordLinkWelcomeMessage(discordUser.username),
        );
        this.sendResult(res, 'success');
        return;
      }

      // Not in the guild yet — send them straight to the invite; the bot
      // delivers the welcome DM on `guildMemberAdd` (link is already done).
      this.sendResult(res, 'not-in-guild');
    } catch (error) {
      this.logger.error(
        `Discord OAuth callback failed: ${errorMessage(error)}`,
      );
      this.sendResult(res, 'error');
    }
  }

  private async upsertLinkWithRetry(
    userId: number,
    discordUserId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPSERT_MAX_ATTEMPTS; attempt++) {
      try {
        await this.accountLinkService.upsertLink(userId, discordUserId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < UPSERT_MAX_ATTEMPTS) {
          await new Promise((r) =>
            setTimeout(r, UPSERT_BASE_BACKOFF_MS * attempt),
          );
        }
      }
    }
    throw lastError;
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
