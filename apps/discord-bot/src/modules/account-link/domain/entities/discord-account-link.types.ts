export type DiscordLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export interface DiscordLinkVerifySuccess {
  valid: true;
  userId: number;
}

export interface DiscordLinkVerifyFailure {
  valid: false;
  reason: DiscordLinkVerifyFailureReason;
}

export type DiscordLinkVerifyResult =
  | DiscordLinkVerifySuccess
  | DiscordLinkVerifyFailure;
