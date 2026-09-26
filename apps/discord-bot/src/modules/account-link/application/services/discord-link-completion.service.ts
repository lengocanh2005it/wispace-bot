import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import {
  LinkCompletionCore,
  LinkConflictError,
  LinkPersistenceExhaustedError,
  LinkTokenRejectedError,
} from '@wispace/account-link-core/core';
import type {
  LinkCompletionAfterCommitContext,
  LinkFlowAdapter,
} from '@wispace/account-link-core/core';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { WispaceTokenVerifyService } from '@wispace/wispace-client/adapters';
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

const linkCompletionFailuresTotal = new Counter({
  name: 'discord_link_completion_failures_total',
  help: 'Discord account-link completion failures',
  labelNames: ['reason'] as const,
});

/** Result of completing the Discord OAuth link — maps to the landing redirect. */
export type DiscordLinkCompletionOutcome = 'success' | 'not-in-guild';

/**
 * Discord OAuth callback facade. The shared core owns ordering, retries, and
 * best-effort cleanup; this class only supplies Discord exchange and effects.
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

  async completeLink(
    code: string,
    token: string,
  ): Promise<DiscordLinkCompletionOutcome> {
    const adapter: LinkFlowAdapter<void> = {
      exchange: async () => {
        const user =
          await this.accountLinkService.exchangeCodeForDiscordUser(code);
        return { externalUserId: user.id, displayName: user.username };
      },
      verifyToken: async (linkToken, externalUserId) =>
        this.tokenVerifyService.verifyToken(linkToken, externalUserId),
      getMappingObservation: async (externalUserId) => {
        if (!this.linkState) {
          throw new Error('Discord link state service is required');
        }
        const state = await this.linkState.getLink('discord', externalUserId);
        return !state
          ? { kind: 'absent' }
          : state.state === 'locally-unlinked' && state.userId === undefined
            ? { kind: 'absent', generation: state.generation }
            : { kind: 'present', generation: state.generation };
      },
      recordVerify: (externalUserId, userId, mappingObservation) =>
        this.verifyRecordService.recordVerify(
          externalUserId,
          userId,
          mappingObservation,
        ),
      upsertLink: (userId, externalUserId, mappingObservation) =>
        this.accountLinkService.upsertLink(
          userId,
          externalUserId,
          mappingObservation,
        ),
      consumeRecord: (intent) =>
        this.verifyRecordService.consumeRecord({
          discordUserId: intent.externalUserId,
          userId: intent.userId,
          intentGeneration: intent.intentGeneration,
        }),
      clearClarification: async (externalUserId) => {
        await this.clarificationStateStore.clear(`discord:${externalUserId}`);
      },
      afterCommit: (context) => this.afterCommit(context),
    };
    const core = new LinkCompletionCore(adapter, {
      onBestEffortError: (step, error) => {
        this.logger.warn(`Discord link ${step} failed: ${errorMessage(error)}`);
      },
    });

    try {
      const result = await core.complete({
        input: undefined,
        linkToken: token,
      });
      return result.nextAction === 'join-community'
        ? 'not-in-guild'
        : 'success';
    } catch (error) {
      if (!(error instanceof LinkTokenRejectedError)) {
        linkCompletionFailuresTotal.inc({
          reason:
            error instanceof LinkPersistenceExhaustedError
              ? 'persistence_exhausted'
              : error instanceof LinkConflictError
                ? 'conflict'
                : 'unexpected',
        });
      }
      throw error;
    }
  }

  private async afterCommit({
    identity,
    userId,
    linkResult,
  }: LinkCompletionAfterCommitContext): Promise<{
    nextAction?: 'join-community';
  }> {
    if (linkResult.relinked) {
      await this.relinkNotifier
        .notify(identity.externalUserId, linkResult.previousUserId, userId)
        .catch((error: unknown) => {
          this.logger.warn(
            `Discord relink notification failed for discordUserId=${maskExternalId(
              identity.externalUserId,
            )}: ${errorMessage(error, identity.externalUserId)}`,
          );
        });
    }

    const inGuild = await this.guildMembershipService.isMember(
      identity.externalUserId,
    );
    if (!inGuild) return { nextAction: 'join-community' };

    await this.welcomeService
      .welcomeIfDue(identity.externalUserId, identity.displayName, userId)
      .catch((error: unknown) => {
        this.logger.warn(
          `Discord link welcome failed for discordUserId=${maskExternalId(
            identity.externalUserId,
          )}: ${errorMessage(error, identity.externalUserId)}`,
        );
      });
    await this.accountLinkService
      .sendConsentExplainerIfDue(identity.externalUserId, async (text) => {
        await this.outboundService.sendText(identity.externalUserId, text, {
          userId,
        });
      })
      .catch(() => undefined);
    return {};
  }
}
