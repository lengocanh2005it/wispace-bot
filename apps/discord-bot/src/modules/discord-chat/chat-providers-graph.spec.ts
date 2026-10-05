import {
  PlatformAgentService,
  PlatformChatHistoryService,
  RedisChatQueueWorkerService,
} from '@wispace/chat-agent';
import { findEffectiveFactoryProvider } from '@wispace/bot-common/testing';
import { DiscordChatModule } from './discord-chat.module';

/**
 * #1127: this file pins **which bindings must exist** for `app.boot.spec.ts` to
 * be able to resolve the graph at all. It does not resolve the graph itself:
 * nothing here calls `Test.createTestingModule(...).compile()`, and metadata
 * presence is not resolvability — a binding whose dependency is missing resolves
 * to `undefined` silently while the app still boots. `app.boot.spec.ts` is the
 * seam that resolves; the value of the assertions below is that they turn a
 * binding the factory forgot to provide into a failing test instead of a runtime
 * `undefined`.
 *
 * The static guard (`.github/scripts/check-platform-chat-providers.sh`) reads
 * module *source*; these read the provider metadata Nest actually resolves, so
 * they also catch a factory call that silently drops a provider.
 */

/**
 * `LEARNER_PROFILE_STORE` is named by its token value rather than imported:
 * #1127 moved the binding into the factory, and with it the apps'
 * `@wispace/learner-profile` dependency (#e916c755). The token is a plain
 * string, so a rename fails the binding count below loudly instead of passing.
 */
const LEARNER_PROFILE_STORE = 'LEARNER_PROFILE_STORE';

/**
 * The four tokens `createPlatformChatProviders` provides, written out
 * literally on purpose. Deriving this from `PLATFORM_CHAT_PROVIDER_TOKENS` and
 * filtering at collection time looks equivalent and is not: delete every
 * binding for a token and the filter empties the `it.each` block, so the suite
 * passes having asserted nothing. A literal table keeps the coverage reviewable
 * at a glance — all four, or a deliberate edit.
 */
const SHARED_CHAT_SPINE_TOKENS = [
  PlatformChatHistoryService,
  PlatformAgentService,
  RedisChatQueueWorkerService,
  LEARNER_PROFILE_STORE,
];

/**
 * `LEARNER_PROFILE_STORE` is deliberately absent from the group below: the
 * factory binds it with `useClass`, and `findEffectiveFactoryProvider` only
 * matches `useFactory` bindings, so it would return `undefined` for it by
 * construction. Its presence is still asserted by the count test above.
 */
const USE_FACTORY_SPINE_TOKENS = [
  PlatformChatHistoryService,
  PlatformAgentService,
  RedisChatQueueWorkerService,
];

const bindingsFor = (token: unknown): unknown[] => {
  const providers: unknown[] =
    Reflect.getMetadata('providers', DiscordChatModule) ?? [];
  return providers.filter(
    (provider) =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token,
  );
};

describe('DiscordChatModule — shared chat spine (#1127)', () => {
  it.each(SHARED_CHAT_SPINE_TOKENS)(
    'binds %s exactly once — provided by the factory, never re-declared',
    (token) => {
      expect(bindingsFor(token)).toHaveLength(1);
    },
  );

  it.each(USE_FACTORY_SPINE_TOKENS)(
    'resolves %s through the effective binding Nest reads',
    (token) => {
      // #1507: the last binding wins, so a first-match lookup would keep passing
      // after the override it was reading was deleted.
      expect(
        findEffectiveFactoryProvider(DiscordChatModule, token),
      ).toBeDefined();
    },
  );
});
