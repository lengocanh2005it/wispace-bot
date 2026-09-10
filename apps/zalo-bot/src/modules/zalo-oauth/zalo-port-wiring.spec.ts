import { ZaloOauthModule } from './zalo-oauth.module';
import { ZALO_OAUTH_CLIENT } from './application/ports/zalo-oauth-client.port';
import {
  ZALO_OA_ACCESS_TOKEN,
  ZALO_OA_TOKEN_STORE,
} from './application/ports/zalo-oa-token-store.port';
import { ZALO_OAUTH_STATE_STORE } from './application/ports/zalo-oauth-state-store.port';
import { ZaloOAuthHttpAdapter } from './infrastructure/adapters/zalo-oauth-http.adapter';
import { TypeormZaloOaTokenStoreAdapter } from './infrastructure/adapters/typeorm-zalo-oa-token-store.adapter';
import { TypeormZaloOauthStateStoreAdapter } from './infrastructure/adapters/typeorm-zalo-oauth-state-store.adapter';
import { ZaloTokenService } from './application/services/zalo-token.service';

describe('Zalo OAuth port wiring', () => {
  it('binds application tokens to concrete adapters at the composition root', () => {
    const providers = (Reflect.getMetadata('providers', ZaloOauthModule) ??
      []) as Array<unknown>;
    const aliases = providers.filter(
      (
        provider,
      ): provider is {
        provide: unknown;
        useExisting: unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        'useExisting' in provider,
    );

    expect(aliases).toEqual(
      expect.arrayContaining([
        { provide: ZALO_OAUTH_CLIENT, useExisting: ZaloOAuthHttpAdapter },
        {
          provide: ZALO_OA_TOKEN_STORE,
          useExisting: TypeormZaloOaTokenStoreAdapter,
        },
        {
          provide: ZALO_OAUTH_STATE_STORE,
          useExisting: TypeormZaloOauthStateStoreAdapter,
        },
        { provide: ZALO_OA_ACCESS_TOKEN, useExisting: ZaloTokenService },
      ]),
    );
  });
});
