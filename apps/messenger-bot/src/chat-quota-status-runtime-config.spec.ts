import { ChatRuntimeConfig } from '@wispace/chat-agent';

// The CLI adapter is intentionally loaded through CommonJS so this Jest test
// can exercise the same JavaScript entrypoint without opening a database.
const { createChatRuntimeConfig } = module.require(
  '../scripts/chat-quota-status-runtime-config.cjs',
) as {
  createChatRuntimeConfig: (env: NodeJS.ProcessEnv) => ChatRuntimeConfig;
};

describe('chat-quota status CLI runtime config', () => {
  it('uses the shared immutable resolver and snapshots env values', () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_QUEUE_STORE: 'redis',
      CHAT_HISTORY_STORE: 'memory',
      CHAT_HISTORY_MAX_MESSAGES: '37',
    };

    const config = createChatRuntimeConfig(env);
    env.CHAT_QUEUE_STORE = 'memory';
    env.CHAT_HISTORY_MAX_MESSAGES = '1';

    expect(config).toBeInstanceOf(ChatRuntimeConfig);
    expect(config.queueMode()).toBe('redis');
    expect(config.history('CHAT_HISTORY_')).toMatchObject({
      store: 'memory',
      maxMessages: 37,
    });
  });
});
