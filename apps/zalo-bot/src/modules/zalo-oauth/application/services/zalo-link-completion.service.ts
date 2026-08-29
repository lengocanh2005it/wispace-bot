import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { buildLinkSuccessMessage } from '@wispace/bot-common/messages';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { sleep } from '@wispace/bot-common/utils';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { ZaloOutboundService } from '@zalo/modules/zalo-chat/application/services/zalo-outbound.service';
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

const UPSERT_MAX_ATTEMPTS = 3;
const UPSERT_BASE_BACKOFF_MS = 500;

/** The WISPACE link token was rejected (already used / invalid). */
export class ZaloLinkTokenRejectedError extends Error {
  constructor() {
    super('WISPACE link token rejected');
  }
}

/**
 * Zalo OAuth callback use case (#147, mirror of DiscordLinkCompletionService
 * #137): exchange code → verify WISPACE token → persist durable verify
 * intent → commit the mapping (retried — WISPACE already consumed the
 * single-use token) → consume intent → welcome message.
 */
@Injectable()
export class ZaloLinkCompletionService {
  private readonly logger = new Logger(ZaloLinkCompletionService.name);

  constructor(
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly tokenVerifyService: WispaceTokenVerifyService,
    @Inject(ZALO_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: ZaloLinkVerifyRecordRepositoryPort,
    private readonly outboundService: ZaloOutboundService,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
    @Optional() private readonly linkState?: PlatformLinkStateService,
  ) {}

  /**
   * Runs the callback flow. Throws on failure — the controller maps any
   * error to a generic retry message (the user retries with a fresh token).
   */
  async completeLink(
    code: string,
    codeVerifier: string,
    linkToken: string,
  ): Promise<void> {
    const zaloUser = await this.accountLinkService.exchangeCodeForZaloUser(
      code,
      codeVerifier,
    );
    const observedLink = await this.linkState?.getLink('zalo', zaloUser.id);

    const verifyResult = await this.tokenVerifyService.verifyToken(
      linkToken,
      zaloUser.id,
    );
    if (!verifyResult.valid) {
      throw new ZaloLinkTokenRejectedError();
    }

    // WISPACE has already consumed the link token (single-use) — the mapping
    // MUST be committed now, or WISPACE shows "linked" while the bot has no
    // mapping. Persist a durable verify intent BEFORE the upsert so the
    // reconcile cron re-commits the mapping if we crash in between (#147).
    await this.verifyRecordService.recordVerify(
      zaloUser.id,
      verifyResult.userId,
    );

    await this.retryUpsert(
      verifyResult.userId,
      zaloUser.id,
      observedLink?.generation,
    );
    await this.clarificationStateStore
      .clear(`zalo:${zaloUser.id}`)
      .catch((error: unknown) => {
        this.logger.warn(
          `Zalo clarification state clear failed for zaloUserId=${maskExternalId(
            zaloUser.id,
          )}: ${errorMessage(error, zaloUser.id)}`,
        );
      });

    // Intent consumed — the mapping is committed (fire-and-forget; a race
    // leaves a record that the reconcile cron cleans up).
    await this.verifyRecordService
      .consumeRecord(zaloUser.id)
      .catch((error: unknown) => {
        this.logger.warn(
          `Zalo link verify record cleanup failed for zaloUserId=${maskExternalId(
            zaloUser.id,
          )}: ${errorMessage(error, zaloUser.id)}`,
        );
      });

    // Welcome comes AFTER the mapping is committed — a send failure must not
    // make an already-committed link appear uncommitted.
    await this.outboundService
      .sendText(zaloUser.id, buildLinkSuccessMessage())
      .catch((error: unknown) => {
        this.logger.warn(
          `Zalo link welcome send failed for zaloUserId=${maskExternalId(
            zaloUser.id,
          )}: ${errorMessage(error, zaloUser.id)}`,
        );
      });
  }

  private async retryUpsert(
    userId: number,
    zaloUserId: string,
    expectedGeneration?: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPSERT_MAX_ATTEMPTS; attempt++) {
      try {
        if (expectedGeneration === undefined) {
          await this.accountLinkService.upsertLink(userId, zaloUserId);
        } else {
          await this.accountLinkService.upsertLink(userId, zaloUserId, {
            expectedGeneration,
          });
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < UPSERT_MAX_ATTEMPTS) {
          await sleep(UPSERT_BASE_BACKOFF_MS * attempt);
        }
      }
    }
    throw lastError;
  }
}
