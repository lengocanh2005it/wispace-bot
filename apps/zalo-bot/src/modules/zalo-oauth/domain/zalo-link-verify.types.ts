export type ZaloLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export type ZaloLinkVerifyResult =
  | { valid: true; userId: number }
  | { valid: false; reason: ZaloLinkVerifyFailureReason };
