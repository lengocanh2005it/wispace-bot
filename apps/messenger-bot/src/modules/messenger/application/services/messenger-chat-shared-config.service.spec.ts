import { ConfigService } from '@nestjs/config';
import { ChatRuntimeConfig } from '@wispace/chat-agent';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

describe('MessengerChatSharedConfigService', () => {
  const createService = (
    env: Record<string, string | undefined>,
    runtimeConfig?: ChatRuntimeConfig,
  ) => {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    return new MessengerChatSharedConfigService(configService, runtimeConfig);
  };

  it('defaults history store to memory', () => {
    const service = createService({});
    expect(service.getHistoryStore()).toBe('memory');
  });

  it('uses redis history when shared queue is enabled without explicit store', () => {
    const service = createService({
      CHAT_QUEUE_SHARED: 'true',
    });
    expect(service.getHistoryStore()).toBe('redis');
  });

  it('reads explicit CHAT_HISTORY_STORE', () => {
    const service = createService({
      CHAT_HISTORY_STORE: 'redis',
      CHAT_QUEUE_SHARED: 'true',
    });
    expect(service.getHistoryStore()).toBe('redis');
  });

  it('defaults queue store to memory', () => {
    const service = createService({});
    expect(service.getQueueStore()).toBe('memory');
    expect(service.isDistributedQueueEnabled()).toBe(false);
  });

  it('uses redis queue when shared queue is enabled without explicit store', () => {
    const service = createService({
      CHAT_QUEUE_SHARED: 'true',
    });
    expect(service.getQueueStore()).toBe('redis');
    expect(service.isDistributedQueueEnabled()).toBe(true);
  });

  it('reads explicit CHAT_QUEUE_STORE=redis', () => {
    const service = createService({
      CHAT_QUEUE_STORE: 'redis',
    });
    expect(service.getQueueStore()).toBe('redis');
    expect(service.isDistributedQueueEnabled()).toBe(true);
  });

  it('uses one injected snapshot for queue and history settings', () => {
    const service = createService(
      {
        CHAT_QUEUE_STORE: 'memory',
        CHAT_QUEUE_PROCESSING_STUCK_MS: '9000',
        CHAT_HISTORY_STORE: 'memory',
        CHAT_HISTORY_TTL_MS: '9000',
        CHAT_HISTORY_MAX_MESSAGES: '12',
        CHAT_HISTORY_MAX_USERS: '12',
      },
      new ChatRuntimeConfig({
        CHAT_QUEUE_STORE: 'redis',
        CHAT_QUEUE_PROCESSING_STUCK_MS: '1234',
        CHAT_HISTORY_STORE: 'redis',
        CHAT_HISTORY_TTL_MS: '5678',
        CHAT_HISTORY_MAX_MESSAGES: '7',
        CHAT_HISTORY_MAX_USERS: '8',
      }),
    );

    expect(service.getQueueStore()).toBe('redis');
    expect(service.getProcessingStuckMs()).toBe(1234);
    expect(service.getHistoryStore()).toBe('redis');
    expect(service.getHistoryTtlMs()).toBe(5678);
    expect(service.getHistoryMaxMessages()).toBe(7);
    expect(service.getHistoryMaxUsers()).toBe(8);
  });
});
