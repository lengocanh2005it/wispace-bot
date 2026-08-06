export type WispaceLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export type WispaceLinkVerifyResult =
  | { valid: true; userId: number }
  | { valid: false; reason: WispaceLinkVerifyFailureReason };
