export const ZALO_TOKEN_VERIFY_PORT = 'ZALO_TOKEN_VERIFY_PORT';

export type ZaloLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export type ZaloLinkVerifyResult =
  | { valid: true; userId: number }
  | { valid: false; reason: ZaloLinkVerifyFailureReason };

/**
 * Port for verifying a WISPACE link token against a Zalo user ID.
 * Implemented by WispaceZaloTokenVerifyService in infrastructure/.
 */
export interface ZaloTokenVerifyPort {
  verifyToken(token: string, zaloUserId: string): Promise<ZaloLinkVerifyResult>;
}
