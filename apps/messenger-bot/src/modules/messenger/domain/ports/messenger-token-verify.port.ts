import type { MessengerLinkVerifyResult } from '../types/messenger-link-verify.types';

export interface MessengerTokenVerifyPort {
  verifyMessengerToken(
    psid: string,
    token: string,
    options?: { signal?: AbortSignal },
  ): Promise<MessengerLinkVerifyResult>;
}

export const MESSENGER_TOKEN_VERIFY = Symbol('MESSENGER_TOKEN_VERIFY');
