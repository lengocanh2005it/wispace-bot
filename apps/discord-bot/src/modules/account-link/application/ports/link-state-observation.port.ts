import type { LinkMappingObservation } from '@wispace/account-link-core/core';

/**
 * Narrow read over the platform link table (#1088). Application services only
 * need the pre-verify mapping observation; the TypeORM-backed
 * `PlatformLinkStateService` stays in infrastructure.
 */
export interface LinkStateObservationPort {
  getMappingObservation(
    externalUserId: string,
  ): Promise<LinkMappingObservation>;
}

export const LINK_STATE_OBSERVATION = Symbol('LINK_STATE_OBSERVATION');
