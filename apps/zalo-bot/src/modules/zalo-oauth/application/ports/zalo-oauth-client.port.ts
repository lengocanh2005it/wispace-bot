import type { ZaloOaTokenPair } from './zalo-oa-token-store.port';

export interface ZaloUserProfile {
  id: string;
  name: string;
}

export interface ZaloOAuthClientPort {
  exchangeCodeForUser(
    code: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<ZaloUserProfile>;
  refreshOaToken(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<ZaloOaTokenPair>;
}

export const ZALO_OAUTH_CLIENT = Symbol('ZALO_OAUTH_CLIENT');
