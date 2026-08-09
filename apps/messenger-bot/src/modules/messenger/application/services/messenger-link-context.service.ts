import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import {
  MessengerLinkContext,
  parseMessengerLinkContext,
} from '@messenger/shared/config/poc.constants';
import type { MessengerLinkResolveOutcome } from '../../domain/types/messenger-link-verify.types';
import { WispaceMessengerTokenVerifyService } from '../../infrastructure/wispace/wispace-messenger-token-verify.service';

@Injectable()
export class MessengerLinkContextService {
  private readonly logger = new Logger(MessengerLinkContextService.name);

  constructor(
    private readonly wispaceTokenVerifyService: WispaceMessengerTokenVerifyService,
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

    try {
      const verified =
        await this.wispaceTokenVerifyService.verifyMessengerToken(psid, ref);

      if (!verified.valid) {
        this.logger.warn(
          `Messenger link verify failed psid=${maskExternalId(psid)} reason=${verified.reason}`,
        );
        return { verifyFailureReason: verified.reason };
      }

      return {
        context: {
          ref,
          userId: verified.userId,
          topic: input.topic?.trim() || verified.topic,
          cadence: verified.cadence,
        },
      };
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(
        `Messenger link verify error psid=${maskExternalId(psid)}: ${message}`,
      );
      return { verifyFailureReason: 'NOT_FOUND' };
    }
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
