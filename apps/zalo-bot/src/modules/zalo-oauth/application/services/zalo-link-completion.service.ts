import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import {
  LinkConflictError,
  LinkCompletionCore,
  LinkPersistenceExhaustedError,
  LinkTokenRejectedError,
  type LinkCompletionAfterCommitContext,
  type LinkFlowAdapter,
} from '@wispace/account-link-core/core';
import { buildLinkSuccessMessage } from '@wispace/bot-common/messages';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import {
  ZALO_OUTBOUND,
  type ZaloOutboundPort,
} from '@zalo/modules/zalo-chat/application/ports/zalo-outbound.port';
import {
  ZALO_LINK_VERIFY_RECORD_REPOSITORY,
  type ZaloLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/zalo-link-verify-record.repository.port';
import { ZaloAccountLinkService } from './zalo-account-link.service';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { PlatformLinkStateService } from '@wispace/database';
import { ZaloRelinkNotifier } from './zalo-relink-notifier.service';
import { ZaloWelcomeService } from './zalo-welcome.service';

const linkCompletionFailuresTotal = new Counter({
  name: 'zalo_link_completion_failures_total',
  help: 'Zalo account-link completion failures',
  labelNames: ['reason'] as const,
});

/** The WISPACE link token was rejected (already used / invalid). */
export class ZaloLinkTokenRejectedError extends Error {
  constructor() {
    super('WISPACE link token rejected');
    this.name = 'ZaloLinkTokenRejectedError';
  }
}

/** Zalo OAuth callback facade; lifecycle ordering lives in account-link-core. */
@Injectable()
export class ZaloLinkCompletionService {
  private readonly logger = new Logger(ZaloLinkCompletionService.name);

  constructor(
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly tokenVerifyService: WispaceTokenVerifyService,
    @Inject(ZALO_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: ZaloLinkVerifyRecordRepositoryPort,
    @Inject(ZALO_OUTBOUND)
    private readonly outboundService: ZaloOutboundPort,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
    @Optional() private readonly linkState?: PlatformLinkStateService,
    @Optional() private readonly welcomeService?: ZaloWelcomeService,
    @Optional() private readonly relinkNotifier?: ZaloRelinkNotifier,
  ) {}

  async completeLink(
    code: string,
    codeVerifier: string,
    linkToken: string,
  ): Promise<void> {
    const adapter: LinkFlowAdapter<{
      code: string;
      codeVerifier: string;
    }> = {
      exchange: async () => {
        const user = await this.accountLinkService.exchangeCodeForZaloUser(
          code,
          codeVerifier,
        );
        return { externalUserId: user.id, displayName: user.name };
      },
      verifyToken: async (token, externalUserId) =>
        this.tokenVerifyService.verifyToken(token, externalUserId),
      getMappingObservation: async (externalUserId) => {
        if (!this.linkState) {
          throw new Error('Zalo link state service is required');
        }
        const state = await this.linkState.getLink('zalo', externalUserId);
        return !state ||
          (state.state === 'locally-unlinked' && state.userId === undefined)
          ? { kind: 'absent' }
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
          zaloUserId: intent.externalUserId,
          userId: intent.userId,
          intentGeneration: intent.intentGeneration,
        }),
      clearClarification: async (externalUserId) => {
        await this.clarificationStateStore.clear(`zalo:${externalUserId}`);
      },
      afterCommit: (context) => this.afterCommit(context),
    };
    const core = new LinkCompletionCore(adapter, {
      onBestEffortError: (step, error) => {
        this.logger.warn(`Zalo link ${step} failed: ${errorMessage(error)}`);
      },
    });

    try {
      await core.complete({
        input: { code, codeVerifier },
        linkToken,
      });
    } catch (error) {
      if (error instanceof LinkTokenRejectedError) {
        throw new ZaloLinkTokenRejectedError();
      }
      linkCompletionFailuresTotal.inc({
        reason:
          error instanceof LinkPersistenceExhaustedError
            ? 'persistence_exhausted'
            : error instanceof LinkConflictError
              ? 'conflict'
              : 'unexpected',
      });
      throw error;
    }
  }

  private async afterCommit({
    identity,
    userId,
    linkResult,
  }: LinkCompletionAfterCommitContext): Promise<void> {
    if (linkResult.relinked && this.relinkNotifier) {
      await this.relinkNotifier
        .notify(identity.externalUserId, userId)
        .catch((error: unknown) => {
          this.logger.warn(
            `Zalo relink notification failed for zaloUserId=${maskExternalId(
              identity.externalUserId,
            )}: ${errorMessage(error, identity.externalUserId)}`,
          );
        });
    }

    if (this.welcomeService) {
      await this.welcomeService.welcomeIfDue(identity.externalUserId, userId);
    } else {
      await this.outboundService
        .sendText(identity.externalUserId, buildLinkSuccessMessage(), {
          userId,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Zalo link welcome send failed for zaloUserId=${maskExternalId(
              identity.externalUserId,
            )}: ${errorMessage(error, identity.externalUserId)}`,
          );
        });
    }

    await this.accountLinkService
      .sendConsentExplainerIfDue(identity.externalUserId, async (text) => {
        await this.outboundService.sendText(identity.externalUserId, text, {
          userId,
        });
      })
      .catch(() => undefined);
  }
}
