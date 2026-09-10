export interface ZaloOauthStateRecord {
  state: string;
  codeVerifier: string;
  linkToken: string;
  createdAt: Date;
}

export interface ZaloOauthStateStorePort {
  save(record: ZaloOauthStateRecord): Promise<void>;
  consume(state: string): Promise<ZaloOauthStateRecord | undefined>;
  cleanupExpired(before: Date, limit: number): Promise<void>;
}

export const ZALO_OAUTH_STATE_STORE = Symbol('ZALO_OAUTH_STATE_STORE');
