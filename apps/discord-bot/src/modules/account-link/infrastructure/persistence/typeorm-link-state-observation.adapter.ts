import { Injectable } from '@nestjs/common';
import { PlatformLinkStateService } from '@wispace/database';
import type { LinkMappingObservation } from '@wispace/account-link-core/core';
import type { LinkStateObservationPort } from '../../application/ports/link-state-observation.port';

@Injectable()
export class TypeormLinkStateObservationAdapter implements LinkStateObservationPort {
  constructor(private readonly linkState: PlatformLinkStateService) {}

  async getMappingObservation(
    externalUserId: string,
  ): Promise<LinkMappingObservation> {
    const state = await this.linkState.getLink('discord', externalUserId);
    if (!state) return { kind: 'absent' };
    return state.state === 'locally-unlinked' && state.userId === undefined
      ? { kind: 'absent', generation: state.generation }
      : { kind: 'present', generation: state.generation };
  }
}
