import type { LinkMappingObservation } from '@wispace/account-link-core/core';

/** Narrow read over the Zalo link table (#1088). */
export interface ZaloLinkStatePort {
  getMappingObservation(zaloUserId: string): Promise<LinkMappingObservation>;
}

export interface ZaloTokenVerifyResult {
  valid: boolean;
  userId?: number;
  topic?: string;
  cadence?: string;
}

/** WISPACE token verification, kept out of the application layer (#1088). */
export interface ZaloTokenVerifyPort {
  verifyToken(
    token: string,
    zaloUserId: string,
  ): Promise<ZaloTokenVerifyResult>;
}

export const ZALO_LINK_STATE = Symbol('ZALO_LINK_STATE');
export const ZALO_TOKEN_VERIFY = Symbol('ZALO_TOKEN_VERIFY');
