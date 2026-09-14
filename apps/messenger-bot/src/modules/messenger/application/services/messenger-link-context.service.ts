import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Counter } from 'prom-client';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { jitteredDelayMs, sleep } from '@wispace/bot-common/utils';
import {
  MessengerLinkContext,
  parseMessengerLinkContext,
} from '@messenger/shared/config/poc.constants';
import type { MessengerLinkResolveOutcome } from '../../domain/types/messenger-link-verify.types';
import {
  MESSENGER_LINK_VERIFY_RECORD_REPOSITORY,
  MESSENGER_LINK_INTENT_LEASE_MS,
  type MessengerLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/messenger-link-verify-record.repository.port';
import {
  MESSENGER_TOKEN_VERIFY,
  type MessengerTokenVerifyPort,
} from '../../domain/ports/messenger-token-verify.port';

const RECORD_VERIFY_MAX_ATTEMPTS = 3;
const RECORD_VERIFY_BASE_DELAY_MS = 50;

const handoffFailuresTotal = new Counter({
  name: 'messenger_link_handoff_failures_total',
  help: 'Messenger link handoff failures after external verification',
  labelNames: ['reason'] as const,
});

@Injectable()
export class MessengerLinkContextService {
  private readonly logger = new Logger(MessengerLinkContextService.name);

  constructor(
    @Inject(MESSENGER_TOKEN_VERIFY)
    private readonly wispaceTokenVerifyAdapter: MessengerTokenVerifyPort,
    @Inject(MESSENGER_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordRepository: MessengerLinkVerifyRecordRepositoryPort,
  ) {}

  async resolveFromRef(
    psid: string,
    input: {
      ref?: string | null;
      topic?: string | null;
      cadence?: string | null;
    },
  ): Promise<MessengerLinkResolveOutcome> {
    const ref = input.ref?.trim();
    if (!ref) {
      return {};
    }

    const normalizedRef = ref.trim();
    const refFingerprint = createHash('sha256')
      .update(normalizedRef)
      .digest('hex');

    let existingRecord;
    let currentRecord;
    try {
      existingRecord = await this.verifyRecordRepository.findByRefFingerprint(
        psid,
        refFingerprint,
      );
      if (!existingRecord) {
        currentRecord = await this.verifyRecordRepository.findByPsid(psid);
      }
    } catch (error) {
      handoffFailuresTotal.inc({ reason: 'intent_lookup_failed' });
      this.logger.error(
        `Messenger link intent lookup failed psid=${maskExternalId(psid)}: ${maskExternalIdInText(
          errorMessage(error),
          psid,
        )}`,
      );
      return { handoffFailure: true };
    }

    if (existingRecord) {
      if (
        existingRecord.status === 'processing' &&
        this.hasActiveLease(existingRecord.leaseExpiresAt)
      ) {
        handoffFailuresTotal.inc({ reason: 'intent_busy' });
        this.logger.warn(
          `Messenger link intent already processing psid=${maskExternalId(psid)}`,
        );
        return { handoffFailure: true };
      }

      return {
        context: {
          ref: normalizedRef,
          userId: existingRecord.userId,
          topic: existingRecord.topic,
          cadence: existingRecord.cadence,
        },
        intentGeneration: existingRecord.intentGeneration,
        intentState: existingRecord.status,
      };
    }

    if (
      currentRecord?.status === 'processing' &&
      this.hasActiveLease(currentRecord.leaseExpiresAt)
    ) {
      handoffFailuresTotal.inc({ reason: 'intent_busy' });
      this.logger.warn(
        `Messenger link intent already processing psid=${maskExternalId(psid)}`,
      );
      return { handoffFailure: true };
    }

    let verified;
    try {
      verified = await this.wispaceTokenVerifyAdapter.verifyMessengerToken(
        psid,
        normalizedRef,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(
        `Messenger link verify error psid=${maskExternalId(
          psid,
        )}: ${maskExternalIdInText(message, psid)}`,
      );
      return { verifyFailureReason: 'NOT_FOUND' };
    }

    if (!verified.valid) {
      this.logger.warn(
        `Messenger link verify failed psid=${maskExternalId(psid)} reason=${verified.reason}`,
      );
      return { verifyFailureReason: verified.reason };
    }

    const topic = input.topic?.trim() || verified.topic;
    const cadence = verified.cadence;
    const recordedIntent = await this.recordVerifyWithRetry({
      psid,
      userId: verified.userId,
      topic,
      cadence,
      refFingerprint,
      leaseMs: MESSENGER_LINK_INTENT_LEASE_MS,
    });

    if (!recordedIntent) {
      return { handoffFailure: true };
    }

    const intentState = recordedIntent.intentState ?? 'pending';
    if (intentState === 'processing' && !recordedIntent.leaseToken) {
      handoffFailuresTotal.inc({ reason: 'intent_busy' });
      this.logger.warn(
        `Messenger link intent already processing psid=${maskExternalId(psid)}`,
      );
      return { handoffFailure: true };
    }

    return {
      context: {
        ref: normalizedRef,
        userId: verified.userId,
        topic,
        cadence,
      },
      intentGeneration: recordedIntent.intentGeneration,
      intentState,
      ...(recordedIntent.leaseToken
        ? { intentLeaseToken: recordedIntent.leaseToken }
        : {}),
    };
  }

  resolveFromMapping(mapping: {
    userId: number;
    topic?: string | null;
    cadence?: MessengerLinkContext['cadence'] | null;
  }): MessengerLinkContext | undefined {
    return parseMessengerLinkContext({
      ref: String(mapping.userId),
      topic: mapping.topic,
      cadence: mapping.cadence,
    });
  }

  private async recordVerifyWithRetry(input: {
    psid: string;
    userId: number;
    topic: string;
    cadence: MessengerLinkContext['cadence'];
    refFingerprint: string;
    leaseMs: number;
  }): Promise<
    | {
        intentGeneration: string;
        intentState: 'pending' | 'processing' | 'committed';
        leaseToken?: string;
      }
    | undefined
  > {
    let lastError: unknown;

    for (let attempt = 0; attempt < RECORD_VERIFY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.verifyRecordRepository.recordVerify(input);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < RECORD_VERIFY_MAX_ATTEMPTS) {
          await sleep(
            jitteredDelayMs(RECORD_VERIFY_BASE_DELAY_MS * 2 ** attempt),
          );
        }
      }
    }

    this.logger.error(
      `Messenger link intent persistence failed psid=${maskExternalId(
        input.psid,
      )}: ${maskExternalIdInText(errorMessage(lastError), input.psid)}`,
    );
    handoffFailuresTotal.inc({ reason: 'intent_persist_failed' });
    return undefined;
  }

  private hasActiveLease(leaseExpiresAt: Date | null): boolean {
    // Missing expiry is treated as active so an unknown owner is never
    // bypassed into a second provider verification.
    return leaseExpiresAt == null || leaseExpiresAt.getTime() > Date.now();
  }
}
