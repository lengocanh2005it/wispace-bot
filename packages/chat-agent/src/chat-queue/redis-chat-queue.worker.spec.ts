import type { ConfigService } from '@nestjs/config';
import type { ChatQueueStorePort } from './chat-queue-store.port';
import { RedisChatQueueWorkerService } from './redis-chat-queue.worker';

describe('RedisChatQueueWorkerService', () => {
  it('polls the durable queue and flushes bounded batches', async () => {
    const listReadyExternalUserIds = jest
      .fn()
      .mockResolvedValue(['messenger-1', 'discord-1', 'zalo-1']);
    const queueStore = {
      listReadyExternalUserIds,
    } as unknown as ChatQueueStorePort;
    const flushReady = jest.fn().mockResolvedValue(undefined);
    const configService = {
      get: (key: string) => (key === 'CHAT_QUEUE_STORE' ? 'redis' : undefined),
    } as unknown as ConfigService;
    const worker = new RedisChatQueueWorkerService(
      configService,
      (limit) => queueStore.listReadyExternalUserIds(limit),
      flushReady,
    );

    await worker.pollReadyBuffers();

    expect(listReadyExternalUserIds).toHaveBeenCalledWith(25);
    expect(flushReady).toHaveBeenCalledTimes(3);
    expect(flushReady).toHaveBeenCalledWith('messenger-1');
    expect(flushReady).toHaveBeenCalledWith('discord-1');
    expect(flushReady).toHaveBeenCalledWith('zalo-1');
  });

  it('does not start a timer for the memory queue', () => {
    const configService = {
      get: () => 'memory',
    } as unknown as ConfigService;
    const worker = new RedisChatQueueWorkerService(
      configService,
      () => Promise.resolve([]),
      jest.fn(),
    );

    worker.onModuleInit();
    worker.onModuleDestroy();
  });
});
