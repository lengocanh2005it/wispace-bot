import { ZaloChatModule } from './zalo-chat.module';
import { ZALO_OUTBOUND } from './application/ports/zalo-outbound.port';
import { ZALO_OUTBOUND_TRANSPORT } from './application/ports/zalo-outbound-transport.port';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloSendApiAdapter } from './infrastructure/adapters/zalo-send-api.adapter';

describe('Zalo outbound port wiring', () => {
  it('wires the shared fail-closed policy into the startup binding', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: string;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === 'LLM_PROVIDER_ADAPTER' &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();
    expect(() =>
      binding!.useFactory(
        {
          get: (key: string) =>
            ({
              NODE_ENV: 'production',
              OPENAI_API_KEY: 'key',
              OPENAI_MODEL: 'gpt-5.4',
              LLM_ALLOWED_BASE_URLS: '',
              LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
            })[key],
        },
        {},
      ),
    ).toThrow(/LLM_ALLOWED_BASE_URLS.*non-empty/i);
  });

  it('binds outbound policy and transport through composition-root tokens', () => {
    const providers = (Reflect.getMetadata('providers', ZaloChatModule) ??
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
        { provide: ZALO_OUTBOUND_TRANSPORT, useExisting: ZaloSendApiAdapter },
        { provide: ZALO_OUTBOUND, useExisting: ZaloOutboundService },
      ]),
    );
  });
});
