import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DiscordAccountLinkService } from '../../application/services/discord-account-link.service';
import { DiscordLinkVerifyRecordService } from '../../application/services/discord-link-verify-record.service';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import {
  buildDiscordLinkWelcomeMessage,
  buildDiscordRelinkNoticeMessage,
} from '../../application/messages/account-link.messages';
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
    private readonly verifyRecordService: DiscordLinkVerifyRecordService,
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
      // mapping. Persist a durable verify intent BEFORE the upsert so the
      // reconciliation cron re-commits the mapping if we crash in between
      // (#137 item 1); retry transient DB failures on the upsert itself.
      await this.verifyRecordService.recordVerify(
        discordUser.id,
        verifyResult.userId,
      );

      const linkResult = await this.upsertLinkWithRetry(
        verifyResult.userId,
        discordUser.id,
      );

      // Intent consumed — the mapping is committed (fire-and-forget; a race
      // leaves a record that the reconcile cron cleans up).
      await this.verifyRecordService
        .consumeRecord(discordUser.id)
        .catch((error: unknown) => {
          this.logger.warn(
            `Discord link verify record cleanup failed for discordUserId=${maskExternalId(
              discordUser.id,
            )}: ${errorMessage(error)}`,
          );
        });

      if (linkResult.relinked) {
        // #137 item 5: the Discord id was linked to a different WISPACE user
        // — notify the account holder that the previous link was displaced.
        await this.outboundService
          .sendText(discordUser.id, buildDiscordRelinkNoticeMessage())
          .catch((error: unknown) => {
            this.logger.warn(
              `Discord relink notice DM failed for discordUserId=${maskExternalId(
                discordUser.id,
              )}: ${errorMessage(error)}`,
            );
          });
      }

      const inGuild = await this.guildMembershipService.isMember(
        discordUser.id,
      );
      if (inGuild) {
        await this.outboundService.sendMenuButtons(
          discordUser.id,
          buildDiscordLinkWelcomeMessage(discordUser.username),
        );
        await this.accountLinkService.markWelcomed(discordUser.id);
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
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPSERT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.accountLinkService.upsertLink(userId, discordUserId);
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
