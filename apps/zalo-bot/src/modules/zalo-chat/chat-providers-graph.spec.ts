import {
  createPlatformChatProviders,
  PLATFORM_CHAT_PROVIDER_TOKENS,
} from '@wispace/chat-agent';
import { findEffectiveFactoryProvider } from '@wispace/bot-common/testing';
import { ZaloChatModule } from './zalo-chat.module';

type ProviderMetadata = { provide?: unknown; useFactory?: unknown };

const moduleProviders = (): ProviderMetadata[] =>
  (Reflect.getMetadata('providers', ZaloChatModule) ??
    []) as ProviderMetadata[];

const bindingsFor = (token: unknown): ProviderMetadata[] =>
  moduleProviders().filter((provider) => provider?.provide === token);

/**
 * #1127: the resolved-graph property the static guard cannot see. The guard
 * reads module source; this reads the provider metadata Nest actually resolves,
 * so a factory that silently drops a provider is caught here.
 */
describe('ZaloChatModule — shared chat spine (#1127)', () => {
  it('publishes a token for every provider the factory returns', () => {
    // Keeps the published list and the factory from disagreeing: a token listed
    // but never provided would make the guard hunt a binding that cannot exist.
    const provided = createPlatformChatProviders({
      platform: 'zalo',
      historyEnvPrefix: 'ZALO_CHAT_HISTORY_',
      historyKeyPrefix: 'chat-history:zalo:',
      promptDir: '/tmp/prompts',
      promptFile: 'zalo-chat.system.txt',
      toolExecutionTimeoutMs: 35_000,
      appendHistory: true,
      queueWorkerReady: Symbol('ready'),
      queueWorkerFlush: Symbol('flush'),
      agentDynamicOptions: Symbol('dynamic'),
    }).map((provider) => (provider as { provide: unknown }).provide);

    expect(provided).toEqual(
      expect.arrayContaining([...PLATFORM_CHAT_PROVIDER_TOKENS]),
    );
  });

  it.each(PLATFORM_CHAT_PROVIDER_TOKENS)(
    'binds %s exactly once — provided by the factory, never re-declared',
    (token) => {
      expect(bindingsFor(token)).toHaveLength(1);
    },
  );

  it.each(
    // The learner-profile store is bound with useClass, so the useFactory-shaped
    // helper cannot see it; the count above still covers it.
    PLATFORM_CHAT_PROVIDER_TOKENS.filter(
      (token) => bindingsFor(token)[0]?.useFactory !== undefined,
    ),
  )('resolves %s through the effective binding Nest reads', (token) => {
    // #1507: the last binding wins, so a first-match lookup would keep passing
    // after the override it was reading was deleted.
    expect(findEffectiveFactoryProvider(ZaloChatModule, token)).toBeDefined();
  });
});
