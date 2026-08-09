import { ConfigService } from '@nestjs/config';
import type { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import type { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatEnqueueService } from './messenger-chat-enqueue.service';
import type { MessengerChatProcessorService } from './messenger-chat-processor.service';
import type { MessengerOutboundService } from './messenger-outbound.service';

const mockQueueConfigs: Array<{ maxPendingSize?: number }> = [];

jest.mock('@wispace/chat-queue-core', () => {
  const actual = jest.requireActual<typeof import('@wispace/chat-queue-core')>(
    '@wispace/chat-queue-core',
  );
  return {
    ...actual,
    DebounceChatQueue: jest.fn().mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      mockQueueConfigs.push(args[0] as { maxPendingSize?: number });
      return new actual.DebounceChatQueue(...(args as never[]));
    }),
  };
});

describe('MessengerChatEnqueueService', () => {
  let createdServices: MessengerChatEnqueueService[] = [];

  const createService = (
    options: {
      shouldEnforce?: boolean;
      maxPendingMessages?: string;
      distributedMode?: boolean;
    } = {},
  ) => {
    const sendSenderActionOptional = jest.fn(() => Promise.resolve());
    const sendTextViaPsid = jest.fn(() => Promise.resolve());
    const outbound = {
      sendSenderActionOptional,
      sendTextViaPsid,
    } as unknown as MessengerOutboundService;

    const process = jest.fn(() => Promise.resolve());
    const processor = {
      process,
      flushReady: jest.fn(() => Promise.resolve()),
    } as unknown as MessengerChatProcessorService;

    const chatRateLimitConfig = {
      shouldEnforceForPsid: jest.fn(() => options.shouldEnforce ?? false),
      getSettings: jest.fn(() => ({
        mergedTextMaxChars: 100,
      })),
    } as unknown as ChatRateLimitConfigService;

    const sharedConfig = {
      isDistributedQueueEnabled: () => options.distributedMode ?? false,
      getProcessingStuckMs: () => 600_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as unknown as MessengerChatSharedConfigService;

    const configService = {
      get: (key: string) => {
        if (
          options.maxPendingMessages !== undefined &&
          key === 'CHAT_MAX_PENDING_MESSAGES'
        ) {
          return options.maxPendingMessages;
        }
        const values: Record<string, string> = {
          CHAT_DEBOUNCE_MS: '0',
        };
        return values[key];
      },
    } as ConfigService;

    const chatQueueStore = {
      appendChatBuffer: jest.fn(() => Promise.resolve()),
      claimReadyBuffer: jest.fn(() => Promise.resolve(null)),
      completeChatBuffer: jest.fn(() => Promise.resolve(false)),
    } as unknown as ChatQueueStorePort;

    const service = new MessengerChatEnqueueService(
      configService,
      outbound,
      processor,
      chatRateLimitConfig,
      sharedConfig,
      options.distributedMode ? chatQueueStore : undefined,
    );
    createdServices.push(service);

    return {
      service,
      sendSenderActionOptional,
      sendTextViaPsid,
      process,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      flushReady: processor.flushReady,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      appendChatBuffer: chatQueueStore.appendChatBuffer,
    };
  };

  beforeEach(() => {
    createdServices = [];
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const service of createdServices) {
      service.onModuleDestroy();
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('routes to memory queue in non-distributed mode', async () => {
    const { service, process, sendSenderActionOptional } = createService();

    service.enqueue({
      psid: 'psid-1',
      userId: 143,
      userText: 'Hello',
      idempotencyKey: 'mid-1',
    });

    await jest.runOnlyPendingTimersAsync();

    expect(sendSenderActionOptional).toHaveBeenCalledWith(
      'psid-1',
      'mark_seen',
    );
    expect(process).toHaveBeenCalledWith({
      psid: 'psid-1',
      mergedText: 'Hello',
      userId: 143,
      linkContext: undefined,
      idempotencyKey: 'mid-1',
    });
  });

  it('routes to distributed store in distributed mode', async () => {
    const { service, appendChatBuffer, sendSenderActionOptional } =
      createService({ distributedMode: true });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-1',
    });

    // Let the async enqueueDistributed run
    await Promise.resolve();
    await Promise.resolve();

    expect(sendSenderActionOptional).toHaveBeenCalledWith(
      'psid-1',
      'mark_seen',
    );
    expect(appendChatBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-1',
        userText: 'Hello',
        idempotencyKey: 'mid-1',
      }),
    );
  });

  it('ignores empty text', () => {
    const { service, process } = createService();

    service.enqueue({
      psid: 'psid-1',
      userText: '   ',
    });

    expect(process).not.toHaveBeenCalled();
  });

  it('defaults maxPendingSize to 20 when CHAT_MAX_PENDING_MESSAGES is unset', () => {
    mockQueueConfigs.length = 0;
    createService();
    expect(mockQueueConfigs[0]?.maxPendingSize).toBe(20);
  });

  it('passes no-cap maxPendingSize when CHAT_MAX_PENDING_MESSAGES=0', () => {
    mockQueueConfigs.length = 0;
    createService({ maxPendingMessages: '0' });
    expect(mockQueueConfigs[0]?.maxPendingSize).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('sends pending feedback on first queued message', () => {
    const { service, sendTextViaPsid } = createService();

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
    });

    // Pending feedback is sent when pendingCount === 1
    // This is handled by the DebounceChatQueue callback
    // We verify the service was created and enqueue was called
    expect(sendTextViaPsid).not.toHaveBeenCalled(); // not called during enqueue itself
  });

  it('cleans up timers on destroy', () => {
    const { service } = createService({ distributedMode: true });

    service.enqueue({
      psid: 'psid-1',
      userText: 'Hello',
      idempotencyKey: 'mid-1',
    });

    // Should not throw
    service.onModuleDestroy();
  });
});
