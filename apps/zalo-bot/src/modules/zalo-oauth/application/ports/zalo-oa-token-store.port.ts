export interface ZaloOaTokenSnapshot {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ZaloOaTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface ZaloOaTokenStorePort {
  readCurrent(): Promise<ZaloOaTokenSnapshot | undefined>;
  refreshWithLock(
    refresh: (
      current: ZaloOaTokenSnapshot,
    ) => Promise<ZaloOaTokenPair | undefined>,
  ): Promise<ZaloOaTokenSnapshot | undefined>;
}

export const ZALO_OA_TOKEN_STORE = Symbol('ZALO_OA_TOKEN_STORE');

export interface ZaloOaAccessTokenPort {
  getValidAccessToken(): Promise<string>;
  refreshNow(): Promise<void>;
}

export const ZALO_OA_ACCESS_TOKEN = Symbol('ZALO_OA_ACCESS_TOKEN');
