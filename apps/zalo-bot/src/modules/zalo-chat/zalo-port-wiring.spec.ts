import { ZaloChatModule } from './zalo-chat.module';
import { ZALO_OUTBOUND } from './application/ports/zalo-outbound.port';
import { ZALO_OUTBOUND_TRANSPORT } from './application/ports/zalo-outbound-transport.port';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloSendApiAdapter } from './infrastructure/adapters/zalo-send-api.adapter';

describe('Zalo outbound port wiring', () => {
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
