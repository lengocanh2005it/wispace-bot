import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { retryWithBackoff } from '@discord/shared/utils/retry.utils';
import {
  DISCORD_LINK_VERIFY_RECORD_REPOSITORY,
  type DiscordLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/discord-link-verify-record.repository.port';
import { DiscordAccountLinkService } from './discord-account-link.service';
import {
  DISCORD_GUILD_MEMBERSHIP,
  type DiscordGuildMembershipPort,
} from '../../domain/ports/discord-guild-membership.port';
import { DiscordRelinkNotifier } from './discord-relink-notifier.service';
import { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { DiscordWelcomeService } from './discord-welcome.service';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { PlatformLinkStateService } from '@wispace/database';

const UPSERT_MAX_ATTEMPTS = 3;
const UPSERT_BASE_BACKOFF_MS = 500;

/** Result of completing the Discord OAuth link — maps to the landing redirect. */
export type DiscordLinkCompletionOutcome = 'success' | 'not-in-guild';

/**
 * Discord OAuth callback use case — the whole link flow lives here so the
 * presentation layer only redirects:
 * exchange code → verify WISPACE token → persist verify intent → commit the
 * mapping (retried, WISPACE already consumed the single-use token) → consume
 * intent → relink notice → welcome DM (deduped) if already in the guild.
 */
@Injectable()
export class DiscordLinkCompletionService {
  private readonly logger = new Logger(DiscordLinkCompletionService.name);

  constructor(
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly tokenVerifyService: WispaceTokenVerifyService,
    @Inject(DISCORD_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: DiscordLinkVerifyRecordRepositoryPort,
    @Inject(DISCORD_GUILD_MEMBERSHIP)
    private readonly guildMembershipService: DiscordGuildMembershipPort,
    private readonly relinkNotifier: DiscordRelinkNotifier,
    private readonly outboundService: DiscordOutboundService,
    private readonly welcomeService: DiscordWelcomeService,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
    @Optional() private readonly linkState?: PlatformLinkStateService,
  ) {}

  /**
   * Runs the callback flow. Throws on failure — the controller maps any
   * error to the landing page (the user retries with a fresh token).
   */
  async completeLink(
    code: string,
    token: string,
  ): Promise<DiscordLinkCompletionOutcome> {
    const discordUser =
      await this.accountLinkService.exchangeCodeForDiscordUser(code);
    const observedLink = await this.linkState?.getLink(
      'discord',
      discordUser.id,
    );

    const verifyResult = await this.tokenVerifyService.verifyToken(
      token,
      discordUser.id,
    );
    if (!verifyResult.valid) {
      throw new Error('WISPACE link token rejected');
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

    const linkResult = await retryWithBackoff(
      () =>
        observedLink?.generation === undefined
          ? this.accountLinkService.upsertLink(
              verifyResult.userId,
              discordUser.id,
            )
          : this.accountLinkService.upsertLink(
              verifyResult.userId,
              discordUser.id,
              {
                expectedGeneration: observedLink.generation,
              },
            ),
      UPSERT_MAX_ATTEMPTS,
      UPSERT_BASE_BACKOFF_MS,
    );

    await this.clearClarificationState(discordUser.id);

    // Intent consumed — the mapping is committed (fire-and-forget; a race
    // leaves a record that the reconcile cron cleans up).
    await this.verifyRecordService
      .consumeRecord(discordUser.id)
      .catch((error: unknown) => {
        this.logger.warn(
          `Discord link verify record cleanup failed for discordUserId=${maskExternalId(
            discordUser.id,
          )}: ${errorMessage(error, discordUser.id)}`,
        );
      });

    if (linkResult.relinked) {
      // #137 item 5: the Discord id was linked to a different WISPACE user
      // — notify the account holder that the previous link was displaced.
      await this.relinkNotifier
        .notify(discordUser.id, linkResult.previousUserId, verifyResult.userId)
        .catch((error: unknown) => {
          this.logger.warn(
            `Discord relink notification failed for discordUserId=${maskExternalId(
              discordUser.id,
            )}: ${errorMessage(error, discordUser.id)}`,
          );
        });
    }

    const inGuild = await this.guildMembershipService.isMember(discordUser.id);
    if (inGuild) {
      // #137 items 2+4: deduped against a `guildMemberAdd` that raced the
      // callback (whoever runs first welcomes + marks; the other skips).
      await this.welcomeService.welcomeIfDue(
        discordUser.id,
        discordUser.username,
        verifyResult.userId,
      );
      // One-time consent explainer after the welcome (#596); claimed
      // atomically, released if the DM send fails so guildMemberAdd retries.
      await this.accountLinkService
        .sendConsentExplainerIfDue(discordUser.id, async (text) => {
          await this.outboundService.sendText(discordUser.id, text, {
            userId: verifyResult.userId,
          });
        })
        .catch(() => undefined);
      return 'success';
    }

    // Not in the guild yet — send them straight to the invite; the bot
    // delivers the welcome DM on `guildMemberAdd` (link is already done).
    return 'not-in-guild';
  }

  private async clearClarificationState(discordUserId: string): Promise<void> {
    try {
      await this.clarificationStateStore.clear(`discord:${discordUserId}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Discord clarification state clear failed for discordUserId=${maskExternalId(
          discordUserId,
        )}: ${errorMessage(error, discordUserId)}`,
      );
    }
  }
}
