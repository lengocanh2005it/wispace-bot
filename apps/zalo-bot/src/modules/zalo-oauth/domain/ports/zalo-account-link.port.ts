import type {
  LinkMappingObservation,
  LinkUpsertResult,
} from '@wispace/account-link-core/core';
import type { PlatformLinkState } from '@wispace/contracts';

export interface ZaloLinkIdentity {
  userId: number;
  mappingVersion: string;
}

export interface ZaloMappingState {
  state: PlatformLinkState;
  userId?: number;
}

/** The Zalo account-link surface consumed by application code (#1088). */
export interface ZaloAccountLinkPort {
  buildPkcePair(): { codeVerifier: string; codeChallenge: string };

  exchangeCodeForZaloUser(
    code: string,
    codeVerifier: string,
  ): Promise<{ id: string; name: string }>;

  upsertLink(
    userId: number,
    zaloUserId: string,
    mappingObservation: LinkMappingObservation,
  ): Promise<LinkUpsertResult>;

  findUserIdByZaloId(zaloUserId: string): Promise<number | undefined>;

  findMappingStateByZaloId(zaloUserId: string): Promise<ZaloMappingState>;

  findCurrentIdentity(
    zaloUserId: string,
  ): Promise<ZaloLinkIdentity | undefined>;

  sendConsentExplainerIfDue(
    zaloUserId: string,
    send: (text: string) => Promise<void>,
  ): Promise<boolean>;

  suppressOptOutNotice(zaloUserId: string): Promise<void>;
}

export const ZALO_ACCOUNT_LINK = Symbol('ZALO_ACCOUNT_LINK');
