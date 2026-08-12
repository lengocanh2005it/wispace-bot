import { ConfigService } from '@nestjs/config';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

describe('MessengerChatSharedConfigService', () => {
  const createService = (env: Record<string, string | undefined>) => {
    const configService = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;

    return new MessengerChatSharedConfigService(configService);
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
});
