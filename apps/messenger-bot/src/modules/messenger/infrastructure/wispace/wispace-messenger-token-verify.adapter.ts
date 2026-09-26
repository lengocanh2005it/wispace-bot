import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { WispaceTokenVerifyService } from '@wispace/wispace-client/adapters';
import {
  isValidCadence,
  normalizeCadence,
  POC_DEFAULT_LINK_CADENCE,
  POC_DEFAULT_LINK_TOPIC,
} from '@messenger/shared/config/poc.constants';
import type { MessengerTokenVerifyPort } from '../../domain/ports/messenger-token-verify.port';
import type { MessengerLinkVerifyResult } from '../../domain/types/messenger-link-verify.types';

@Injectable()
export class WispaceMessengerTokenVerifyAdapter implements MessengerTokenVerifyPort {
  constructor(private readonly tokenVerifyService: WispaceTokenVerifyService) {}

  async verifyMessengerToken(
    psid: string,
    token: string,
    options?: { signal?: AbortSignal },
  ): Promise<MessengerLinkVerifyResult> {
    const verified = await this.tokenVerifyService.verifyToken(
      token,
      psid,
      options,
    );

    if (!verified.valid) {
      return verified;
    }

    const topic = verified.topic?.trim() || POC_DEFAULT_LINK_TOPIC;
    const cadence = verified.cadence?.trim() || POC_DEFAULT_LINK_CADENCE;

    if (!isValidCadence(cadence)) {
      throw new InternalServerErrorException(
        `WISPACE verify-messenger-token returned invalid cadence: ${verified.cadence}`,
      );
    }

    return {
      valid: true,
      userId: verified.userId,
      topic,
      cadence: normalizeCadence(cadence),
    };
  }
}
