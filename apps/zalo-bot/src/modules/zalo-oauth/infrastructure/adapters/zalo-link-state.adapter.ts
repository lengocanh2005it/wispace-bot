import { Injectable } from '@nestjs/common';
import { WispaceTokenVerifyService } from '@wispace/wispace-client/adapters';
import { PlatformLinkStateService } from '@wispace/database';
import type { LinkMappingObservation } from '@wispace/account-link-core/core';
import type {
  ZaloLinkStatePort,
  ZaloTokenVerifyPort,
} from '../../domain/ports/zalo-link-state.port';

@Injectable()
export class ZaloTokenVerifyAdapter implements ZaloTokenVerifyPort {
  constructor(private readonly tokenVerify: WispaceTokenVerifyService) {}

  verifyToken(token: string, zaloUserId: string) {
    return this.tokenVerify.verifyToken(token, zaloUserId);
  }
}

@Injectable()
export class ZaloLinkStateAdapter implements ZaloLinkStatePort {
  constructor(private readonly linkState: PlatformLinkStateService) {}

  async getMappingObservation(
    zaloUserId: string,
  ): Promise<LinkMappingObservation> {
    const state = await this.linkState.getLink('zalo', zaloUserId);
    if (!state) return { kind: 'absent' };
    return state.state === 'locally-unlinked' && state.userId === undefined
      ? { kind: 'absent', generation: state.generation }
      : { kind: 'present', generation: state.generation };
  }
}
