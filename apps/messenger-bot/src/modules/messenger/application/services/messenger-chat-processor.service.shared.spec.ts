import type { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatProcessorService } from './messenger-chat-processor.service';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';

describe('MessengerChatProcessorService distributed mode (H7/R4)', () => {
  it('claims ready buffer and processes batch', async () => {
    jest.useFakeTimers();

    const appendChatBuffer = jest.fn(() => Promise.resolve());
    const claimReadyBuffer = jest.fn(() =>
      Promise.resolve({
        texts: ['hello'],
        userId: undefined,
        linkContext: undefined,
        lastIdempotencyKey: 'mid-1',
      }),
    );
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
    const sendTextBubblesViaPsid = jest.fn(() => Promise.resolve(1));
    const metrics = {
      chatStep: { startTimer: jest.fn(() => jest.fn()) },
      timeStep: jest.fn((_step: string, fn: () => Promise<unknown>) => fn()),
      timeLlmCall: jest.fn(
        (_f: string, _m: string, _r: number, fn: () => Promise<unknown>) =>
          fn(),
      ),
    } as unknown as MetricsService;

    const service = new MessengerChatProcessorService(
      { get: () => '0' } as never,
      { sendSenderActionOptional, sendTextBubblesViaPsid } as never,
      {
        reply: jest.fn(() =>
          Promise.resolve({ text: 'Bot reply', richFollowUps: [] }),
        ),
      } as never,
      { getHistory: jest.fn(() => Promise.resolve([])) } as never,
      {} as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({
          mergedTextMaxChars: 4000,
          remainingHintThreshold: 3,
        })),
      } as never,
      metrics,
      {} as never,
      sharedConfig,
      chatQueueStore,
    );

    await service.flushReady('psid-shared');

    expect(claimReadyBuffer).toHaveBeenCalledWith('psid-shared', 0, 300_000);

    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
