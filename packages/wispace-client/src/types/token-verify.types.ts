export type WispaceLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export type WispaceLinkVerifyResult =
  | {
      valid: true;
      userId: number;
      topic?: string;
      cadence?: string;
    }
  | { valid: false; reason: WispaceLinkVerifyFailureReason };
