import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
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
  type MessengerLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/messenger-link-verify-record.repository.port';
import { WispaceMessengerTokenVerifyService } from '../../infrastructure/wispace/wispace-messenger-token-verify.service';

const RECORD_VERIFY_MAX_ATTEMPTS = 3;
const RECORD_VERIFY_BASE_DELAY_MS = 50;

@Injectable()
export class MessengerLinkContextService {
  private readonly logger = new Logger(MessengerLinkContextService.name);

  constructor(
    private readonly wispaceTokenVerifyService: WispaceMessengerTokenVerifyService,
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
    try {
      existingRecord = await this.verifyRecordRepository.findByRefFingerprint(
        psid,
        refFingerprint,
      );
    } catch (error) {
      this.logger.error(
        `Messenger link intent lookup failed psid=${maskExternalId(psid)}: ${maskExternalIdInText(
          errorMessage(error),
          psid,
        )}`,
      );
      return { handoffFailure: true };
    }

    if (existingRecord) {
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

    let verified;
    try {
      verified = await this.wispaceTokenVerifyService.verifyMessengerToken(
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
    const intentGeneration = await this.recordVerifyWithRetry({
      psid,
      userId: verified.userId,
      topic,
      cadence,
      refFingerprint,
    });

    if (!intentGeneration) {
      return { handoffFailure: true };
    }

    return {
      context: {
        ref: normalizedRef,
        userId: verified.userId,
        topic,
        cadence,
      },
      intentGeneration,
      intentState: 'pending',
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
  }): Promise<string | undefined> {
    let lastError: unknown;

    for (let attempt = 0; attempt < RECORD_VERIFY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.verifyRecordRepository.recordVerify(input);
        return result.intentGeneration;
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
    return undefined;
  }
}
