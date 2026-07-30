import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import { DiscordChatQueueService } from './discord-chat-queue.service';
import type { DiscordChatRateLimitService } from '@discord/modules/chat-metering/application/services/discord-chat-rate-limit.service';
import type { DiscordChatHistoryService } from './discord-chat-history.service';
import type { DiscordOutboundService } from './discord-outbound.service';
import type { DiscordAgentService } from '../agent/discord-agent.service';

jest.mock('@wispace/chat-queue-core', () => ({
  DebounceChatQueue: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn(),
    destroy: jest.fn(),
  })),
}));

jest.mock('@wispace/chat-pipeline', () => ({
  ChatPipeline: jest.fn().mockImplementation(() => ({
    flush: jest.fn(),
  })),
}));

describe('DiscordChatQueueService', () => {
  const configGet = jest.fn((key: string) => {
    if (key === 'CHAT_DEBOUNCE_MS') return '2000';
    if (key === 'CHAT_MERGED_TEXT_MAX_CHARS') return '4000';
    return undefined;
  });

  const buildService = () => {
    const config = { get: configGet } as unknown as ConfigService;
    const rateLimit = {} as unknown as DiscordChatRateLimitService;
    const history = {} as unknown as DiscordChatHistoryService;
    const outbound = {} as unknown as DiscordOutboundService;
    const agent = {} as unknown as DiscordAgentService;

    return new DiscordChatQueueService(
      config,
      rateLimit,
      history,
      outbound,
      agent,
    );
  };

  const getQueueMock = (service: DiscordChatQueueService) =>
    (
      service as unknown as {
        queue: { enqueue: jest.Mock; destroy: jest.Mock };
      }
    ).queue;

  const getPipelineMock = (service: DiscordChatQueueService) =>
    (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline;

  const getFlushCallback = () => {
    const MockedDebounceChatQueue = jest.mocked(DebounceChatQueue);
    return MockedDebounceChatQueue.mock.calls[0][1] as (
      batch: unknown,
    ) => Promise<void>;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates DebounceChatQueue and ChatPipeline in constructor', () => {
    buildService();

    expect(DebounceChatQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        getDebounceMs: expect.any(Function),
        staleTtlMs: 60 * 60 * 1000,
        cleanupIntervalMs: 15 * 60 * 1000,
      }),
      expect.any(Function),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        onPendingQueued: expect.any(Function),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        onPendingDropped: expect.any(Function),
      }),
    );

    expect(ChatPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ onStep: expect.any(Function) }),
      { mergedTextMaxChars: 4000 },
    );
  });

  it('enqueue delegates to queue.enqueue', () => {
    const service = buildService();
    const queue = getQueueMock(service);

    service.enqueue('discord-1', 'hi', { isServerChannel: false }, 'key-1');

    expect(queue.enqueue).toHaveBeenCalledWith({
      externalUserId: 'discord-1',
      text: 'hi',
      context: { isServerChannel: false },
      idempotencyKey: 'key-1',
    });
  });

  it('onModuleDestroy calls queue.destroy', () => {
    const service = buildService();
    const queue = getQueueMock(service);

    service.onModuleDestroy();

    expect(queue.destroy).toHaveBeenCalled();
  });

  it('handleFlush delegates to pipeline.flush', async () => {
    const service = buildService();
    const pipeline = getPipelineMock(service);
    const flushCb = getFlushCallback();

    await flushCb({
      externalUserId: 'discord-1',
      texts: ['hi'],
      context: { userId: 42, isServerChannel: false },
      idempotencyKey: 'key-1',
    });

    expect(pipeline.flush).toHaveBeenCalledWith({
      externalUserId: 'discord-1',
      userId: 42,
      texts: ['hi'],
      idempotencyKey: 'key-1',
    });
  });

  it('handleFlush logs error on pipeline.flush failure', async () => {
    const service = buildService();
    const pipeline = getPipelineMock(service);
    pipeline.flush.mockRejectedValue(new Error('pipeline boom'));
    const flushCb = getFlushCallback();

    await expect(
      flushCb({
        externalUserId: 'discord-1',
        texts: ['hi'],
        context: {},
        idempotencyKey: 'k',
      }),
    ).resolves.toBeUndefined();
  });

  it('clamps debounce config to 0–10s', () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'CHAT_DEBOUNCE_MS') return '99999';
      if (key === 'CHAT_MERGED_TEXT_MAX_CHARS') return '4000';
      return undefined;
    });

    buildService();
    const MockedDebounceChatQueue = jest.mocked(DebounceChatQueue);
    const cfg1 = MockedDebounceChatQueue.mock.calls[0][0] as {
      getDebounceMs: () => number;
    };
    expect(cfg1.getDebounceMs()).toBe(10_000);

    configGet.mockImplementation((key: string) => {
      if (key === 'CHAT_DEBOUNCE_MS') return '-5';
      return undefined;
    });

    buildService();
    const cfg2 = MockedDebounceChatQueue.mock.calls[1][0] as {
      getDebounceMs: () => number;
    };
    expect(cfg2.getDebounceMs()).toBe(0);
  });
});
