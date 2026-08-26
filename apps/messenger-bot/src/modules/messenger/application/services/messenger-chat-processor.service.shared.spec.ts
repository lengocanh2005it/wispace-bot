import type { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerChatProcessorService } from './messenger-chat-processor.service';
import type { MetricsService } from '@messenger/modules/metrics/metrics.service';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';

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
      { sendSenderActionOptional, sendTextBubblesViaPsid } as never,
      {
        reply: jest.fn(() =>
          Promise.resolve({ text: 'Bot reply', richFollowUps: [] }),
        ),
      } as never,
      {
        reserveFreeFormSlot: jest.fn(() =>
          Promise.resolve({
            allowed: true,
            used: 1,
            limit: 15,
            remaining: 14,
            usageDate: '2026-06-15',
            quotaReserved: true,
          }),
        ),
        markDelivered: jest.fn(() => Promise.resolve()),
        markCompleted: jest.fn(() => Promise.resolve()),
        refundFreeFormSlot: jest.fn(() => Promise.resolve()),
        getRemainingQuota: jest.fn(() =>
          Promise.resolve({ remaining: 14, limit: 15 }),
        ),
      } as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({
          mergedTextMaxChars: 4000,
          remainingHintThreshold: 3,
        })),
      } as never,
      metrics,
      { logMessage: jest.fn(() => Promise.resolve()) } as never,
      sharedConfig,
      {
        getHistory: jest.fn(() => Promise.resolve([])),
        appendTurn: jest.fn(() => Promise.resolve()),
        appendToolSummary: jest.fn(() => Promise.resolve()),
      } as never,
      { get: () => '0' } as never,
      chatQueueStore,
    );

    await service.flushReady('psid-shared');

    expect(claimReadyBuffer).toHaveBeenCalledWith('psid-shared', 0, 300_000);

    jest.useRealTimers();
  });

  it('sends a drop notice when the claimed buffer has dropped messages', async () => {
    jest.useFakeTimers();

    const claimReadyBuffer = jest.fn(() =>
      Promise.resolve({
        texts: ['hello'],
        userId: undefined,
        linkContext: undefined,
        lastIdempotencyKey: 'mid-1',
        droppedNoticePending: true,
      }),
    );
    const completeChatBuffer = jest.fn(() => Promise.resolve(false));
    const chatQueueStore = {
      appendChatBuffer: jest.fn(() => Promise.resolve()),
      claimReadyBuffer,
      completeChatBuffer,
    } as unknown as ChatQueueStorePort;

    const sharedConfig = {
      isDistributedQueueEnabled: () => true,
      getProcessingStuckMs: () => 300_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as MessengerChatSharedConfigService;

    const sendTextViaPsid = jest.fn(() => Promise.resolve());
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
      {
        sendSenderActionOptional: jest.fn(() => Promise.resolve()),
        sendTextBubblesViaPsid,
        sendTextViaPsid,
      } as never,
      {
        reply: jest.fn(() =>
          Promise.resolve({ text: 'Bot reply', richFollowUps: [] }),
        ),
      } as never,
      {
        reserveFreeFormSlot: jest.fn(() =>
          Promise.resolve({
            allowed: true,
            used: 1,
            limit: 15,
            remaining: 14,
            usageDate: '2026-06-15',
            quotaReserved: true,
          }),
        ),
        markDelivered: jest.fn(() => Promise.resolve()),
        markCompleted: jest.fn(() => Promise.resolve()),
        refundFreeFormSlot: jest.fn(() => Promise.resolve()),
        getRemainingQuota: jest.fn(() =>
          Promise.resolve({ remaining: 14, limit: 15 }),
        ),
      } as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({
          mergedTextMaxChars: 4000,
          remainingHintThreshold: 3,
        })),
      } as never,
      metrics,
      { logMessage: jest.fn(() => Promise.resolve()) } as never,
      sharedConfig,
      {
        getHistory: jest.fn(() => Promise.resolve([])),
        appendTurn: jest.fn(() => Promise.resolve()),
        appendToolSummary: jest.fn(() => Promise.resolve()),
      } as never,
      { get: () => '0' } as never,
      chatQueueStore,
    );

    await service.flushReady('psid-shared');

    expect(sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-shared',
        text: 'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé',
        messageType: 'PENDING_FEEDBACK',
      }),
    );

    jest.useRealTimers();
  });

  it('drops messages when mapping is stale after relink/unlink', async () => {
    jest.useFakeTimers();

    const claimReadyBuffer = jest.fn(() =>
      Promise.resolve({
        texts: ['hello'],
        userId: 999,
        linkContext: undefined,
        lastIdempotencyKey: 'mid-stale',
      }),
    );
    const completeChatBuffer = jest.fn(() => Promise.resolve(false));
    const chatQueueStore = {
      appendChatBuffer: jest.fn(() => Promise.resolve()),
      claimReadyBuffer,
      completeChatBuffer,
    } as unknown as ChatQueueStorePort;

    const sharedConfig = {
      isDistributedQueueEnabled: () => true,
      getProcessingStuckMs: () => 300_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as MessengerChatSharedConfigService;

    // Mapping repository returns null — user has unlinked
    const mappingRepository = {
      findActiveMappingByPsid: jest.fn(() => Promise.resolve(null)),
    } as unknown as MessengerMappingRepositoryPort;

    const reply = jest.fn(() =>
      Promise.resolve({ text: 'Bot reply', richFollowUps: [] }),
    );
    const metrics = {
      chatStep: { startTimer: jest.fn(() => jest.fn()) },
      timeStep: jest.fn((_step: string, fn: () => Promise<unknown>) => fn()),
      timeLlmCall: jest.fn(
        (_f: string, _m: string, _r: number, fn: () => Promise<unknown>) =>
          fn(),
      ),
    } as unknown as MetricsService;

    const service = new MessengerChatProcessorService(
      {
        sendSenderActionOptional: jest.fn(() => Promise.resolve()),
        sendTextBubblesViaPsid: jest.fn(() => Promise.resolve(1)),
      } as never,
      { reply } as never,
      {
        reserveFreeFormSlot: jest.fn(() =>
          Promise.resolve({
            allowed: true,
            used: 1,
            limit: 15,
            remaining: 14,
            usageDate: '2026-06-15',
            quotaReserved: true,
          }),
        ),
        markDelivered: jest.fn(() => Promise.resolve()),
        markCompleted: jest.fn(() => Promise.resolve()),
        refundFreeFormSlot: jest.fn(() => Promise.resolve()),
        getRemainingQuota: jest.fn(() =>
          Promise.resolve({ remaining: 14, limit: 15 }),
        ),
      } as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({
          mergedTextMaxChars: 4000,
          remainingHintThreshold: 3,
        })),
      } as never,
      metrics,
      { logMessage: jest.fn(() => Promise.resolve()) } as never,
      sharedConfig,
      {
        getHistory: jest.fn(() => Promise.resolve([])),
        appendTurn: jest.fn(() => Promise.resolve()),
        appendToolSummary: jest.fn(() => Promise.resolve()),
      } as never,
      { get: () => '0' } as never,
      chatQueueStore,
      undefined, // privacyState
      undefined, // privacyService
      mappingRepository,
    );

    await service.flushReady('psid-stale');

    // Mapping was checked
    expect(mappingRepository.findActiveMappingByPsid).toHaveBeenCalledWith(
      'psid-stale',
    );
    // Agent was NOT called — messages dropped
    expect(reply).not.toHaveBeenCalled();
    // Buffer NOT completed — messages dropped without processing (existing behavior)
    expect(completeChatBuffer).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('completes buffer and re-queues when pending messages remain', async () => {
    jest.useFakeTimers();

    const claimReadyBuffer = jest.fn(() =>
      Promise.resolve({
        texts: ['hello'],
        userId: undefined,
        linkContext: undefined,
        lastIdempotencyKey: 'mid-drain',
      }),
    );
    // completeChatBuffer returns true = more messages pending
    const completeChatBuffer = jest.fn(() => Promise.resolve(true));
    const chatQueueStore = {
      appendChatBuffer: jest.fn(() => Promise.resolve()),
      claimReadyBuffer,
      completeChatBuffer,
    } as unknown as ChatQueueStorePort;

    const sharedConfig = {
      isDistributedQueueEnabled: () => true,
      getProcessingStuckMs: () => 300_000,
      getQueueStaleTtlMs: () => 3_600_000,
      getQueueCleanupIntervalMs: () => 900_000,
    } as MessengerChatSharedConfigService;

    const metrics = {
      chatStep: { startTimer: jest.fn(() => jest.fn()) },
      timeStep: jest.fn((_step: string, fn: () => Promise<unknown>) => fn()),
      timeLlmCall: jest.fn(
        (_f: string, _m: string, _r: number, fn: () => Promise<unknown>) =>
          fn(),
      ),
    } as unknown as MetricsService;

    const service = new MessengerChatProcessorService(
      {
        sendSenderActionOptional: jest.fn(() => Promise.resolve()),
        sendTextBubblesViaPsid: jest.fn(() => Promise.resolve(1)),
      } as never,
      {
        reply: jest.fn(() =>
          Promise.resolve({ text: 'Bot reply', richFollowUps: [] }),
        ),
      } as never,
      {
        reserveFreeFormSlot: jest.fn(() =>
          Promise.resolve({
            allowed: true,
            used: 1,
            limit: 15,
            remaining: 14,
            usageDate: '2026-06-15',
            quotaReserved: true,
          }),
        ),
        markDelivered: jest.fn(() => Promise.resolve()),
        markCompleted: jest.fn(() => Promise.resolve()),
        refundFreeFormSlot: jest.fn(() => Promise.resolve()),
        getRemainingQuota: jest.fn(() =>
          Promise.resolve({ remaining: 14, limit: 15 }),
        ),
      } as never,
      {
        shouldEnforceForPsid: jest.fn(() => false),
        getSettings: jest.fn(() => ({
          mergedTextMaxChars: 4000,
          remainingHintThreshold: 3,
        })),
      } as never,
      metrics,
      { logMessage: jest.fn(() => Promise.resolve()) } as never,
      sharedConfig,
      {
        getHistory: jest.fn(() => Promise.resolve([])),
        appendTurn: jest.fn(() => Promise.resolve()),
        appendToolSummary: jest.fn(() => Promise.resolve()),
      } as never,
      { get: () => '0' } as never,
      chatQueueStore,
    );

    await service.flushReady('psid-drain');

    // Buffer was completed
    expect(completeChatBuffer).toHaveBeenCalledWith({
      psid: 'psid-drain',
      debounceMs: 0,
    });

    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
