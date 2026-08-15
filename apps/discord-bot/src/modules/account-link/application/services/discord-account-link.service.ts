import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { maskExternalId } from '@wispace/bot-common';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';

const PLATFORM = 'discord' as const;

const OAUTH_TIMEOUT_MS = 10_000;

class DiscordOauthError extends Error {}

@Injectable()
export class DiscordAccountLinkService {
  private readonly logger = new Logger(DiscordAccountLinkService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly repo: Repository<DiscordAccountLinkEntity>,
  ) {}

  /** Exchanges the OAuth2 `code` for Discord user info (`identify` scope). */
  async exchangeCodeForDiscordUser(
    code: string,
  ): Promise<{ id: string; username: string }> {
    const clientId = this.configService.getOrThrow<string>('DISCORD_CLIENT_ID');
    const clientSecret = this.configService.getOrThrow<string>(
      'DISCORD_CLIENT_SECRET',
    );
    const redirectUri = this.configService.getOrThrow<string>(
      'DISCORD_OAUTH_REDIRECT_URI',
    );

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!tokenResponse.ok) {
      throw new DiscordOauthError(
        `Discord token exchange failed: ${tokenResponse.status}`,
      );
    }

    const tokenJson = (await tokenResponse.json()) as { access_token: string };

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });

    if (!userResponse.ok) {
      throw new DiscordOauthError(
        `Discord user fetch failed: ${userResponse.status}`,
      );
    }

    const userJson = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string;
    };
    return {
      id: userJson.id,
      username: userJson.global_name ?? userJson.username,
    };
  }

  async upsertLink(
    userId: number,
    discordUserId: string,
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    let relinked = false;
    let previousUserId: number | undefined;

    await this.repo.manager.transaction(async (em) => {
      // Detect relink: the Discord id was previously mapped to a different
      // WISPACE user (the displaced user silently loses the link — #137 item 5).
      const existing = await em.query<Array<{ user_id: number }>>(
        `SELECT user_id FROM discord_account_links
         WHERE platform = $1 AND external_user_id = $2`,
        [PLATFORM, discordUserId],
      );
      if (existing[0] && existing[0].user_id !== userId) {
        relinked = true;
        previousUserId = existing[0].user_id;
      }

      // Remove any existing link for this WISPACE user (re-linking with a different Discord account)
      await em.query(
        `DELETE FROM discord_account_links WHERE platform = $1 AND user_id = $2 AND external_user_id != $3`,
        [PLATFORM, userId, discordUserId],
      );
      await em.query(
        `
          INSERT INTO discord_account_links (platform, external_user_id, user_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (platform, external_user_id)
          DO UPDATE SET user_id = EXCLUDED.user_id, linked_at = now()
        `,
        [PLATFORM, discordUserId, userId],
      );
    });

    this.logger.log(
      `Linked Discord account discordUserId=${maskExternalId(
        discordUserId,
      )} userId=${maskExternalId(userId)}${
        relinked && previousUserId !== undefined
          ? ` relinked=previousUserId=${maskExternalId(previousUserId)}`
          : ''
      }`,
    );

    return { relinked, previousUserId };
  }

  async findUserIdByDiscordId(
    discordUserId: string,
  ): Promise<number | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: { userId: true },
    });

    return row?.userId;
  }

  async findDiscordIdByUserId(userId: number): Promise<string | undefined> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, userId },
      select: { externalUserId: true },
    });

    return row?.externalUserId;
  }

  /** Records a welcome DM delivery — dedupes re-welcomes within a window (#137). */
  async markWelcomed(discordUserId: string): Promise<void> {
    await this.repo.update(
      { platform: PLATFORM, externalUserId: discordUserId },
      { lastWelcomedAt: new Date() },
    );
  }

  /**
   * True when no welcome DM was delivered yet, or the last one is older than
   * `windowMs` — used by the OAuth callback and `guildMemberAdd` so a user
   * is never welcomed twice within the window (re-join / join-during-callback
   * races, #137 items 2+4).
   */
  async shouldWelcome(
    discordUserId: string,
    windowMs: number,
  ): Promise<boolean> {
    const row = await this.repo.findOne({
      where: { platform: PLATFORM, externalUserId: discordUserId },
      select: { lastWelcomedAt: true },
    });

    if (!row?.lastWelcomedAt) {
      return true;
    }

    return Date.now() - row.lastWelcomedAt.getTime() >= windowMs;
  }
}
