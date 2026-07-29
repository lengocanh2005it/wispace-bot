import type { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatQueueService } from './messenger-chat-queue.service';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';

describe('MessengerChatQueueService distributed mode (H7/R4)', () => {
  let service: MessengerChatQueueService | undefined;

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('appends to shared buffer and schedules flush', async () => {
    jest.useFakeTimers();

    const appendChatBuffer = jest.fn(() => Promise.resolve());
    const claimReadyBuffer = jest.fn(() => Promise.resolve(null));
    const completeChatBuffer = jest.fn(() => Promise.resolve(false));
    const chatQueueStore = {
      appendChatBuffer,
      claimReadyBuffer,
      completeChatBuffer,
    } as unknown as ChatQueueStorePort;

    const sharedConfig = {
      isDistributedQueueEnabled: () => true,
      getProcessingStuckMs: () => 300_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as MessengerChatSharedConfigService;

    const sendSenderActionOptional = jest.fn(() => Promise.resolve());
    const metrics = {
      chatStep: { startTimer: jest.fn(() => jest.fn()) },
      timeStep: jest.fn((_step: string, fn: () => Promise<unknown>) => fn()),
      timeLlmCall: jest.fn(
        (_f: string, _m: string, _r: number, fn: () => Promise<unknown>) =>
          fn(),
      ),
    } as unknown as MetricsService;

    service = new MessengerChatQueueService(
      { get: () => '0' } as never,
      { sendSenderActionOptional } as never,
      {} as never,
      { getHistory: jest.fn(() => Promise.resolve([])) } as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({ mergedTextMaxChars: 4000 })),
      } as never,
      metrics,
      {} as never,
      sharedConfig,
      chatQueueStore,
    );

    service.enqueue({
      psid: 'psid-shared',
      userText: 'hello',
      idempotencyKey: 'mid-1',
    });

    await flushMicrotasks();

    expect(appendChatBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-shared',
        userText: 'hello',
        idempotencyKey: 'mid-1',
      }),
    );

    jest.runOnlyPendingTimers();
    await flushMicrotasks();

    expect(claimReadyBuffer).toHaveBeenCalledWith('psid-shared', 0, 300_000);

    jest.useRealTimers();
  });

  afterEach(() => {
    service?.onModuleDestroy();
    service = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
