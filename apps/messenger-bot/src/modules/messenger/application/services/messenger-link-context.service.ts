import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
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

    let verified;
    try {
      verified = await this.wispaceTokenVerifyService.verifyMessengerToken(
        psid,
        ref,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(
        `Messenger link verify error psid=${maskExternalId(psid)}: ${message}`,
      );
      return { verifyFailureReason: 'NOT_FOUND' };
    }

    if (!verified.valid) {
      this.logger.warn(
        `Messenger link verify failed psid=${maskExternalId(psid)} reason=${verified.reason}`,
      );
      return { verifyFailureReason: verified.reason };
    }

    // #384: persist a durable verify intent BEFORE the caller commits the
    // mapping, so a crash between WISPACE token verify and local upsert
    // leaves a recoverable intent for the reconciliation cron.
    await this.verifyRecordRepository.recordVerify(psid, verified.userId);

    return {
      context: {
        ref,
        userId: verified.userId,
        topic: input.topic?.trim() || verified.topic,
        cadence: verified.cadence,
      },
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
}
