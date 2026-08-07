import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import { PlatformChatQueueService } from './platform-chat-queue.service';
import type { PlatformChatQueueOptions } from '../agent/platform-agent.types';

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

describe('PlatformChatQueueService', () => {
  const configGet = jest.fn((key: string) => {
    if (key === 'CHAT_DEBOUNCE_MS') return '2000';
    return undefined;
  });

  const buildService = (
    pendingTextSender = { sendText: jest.fn().mockResolvedValue(undefined) },
    options: PlatformChatQueueOptions = {},
  ) => {
    const config = { get: configGet } as unknown as ConfigService;
    const rateLimit = {} as never;
    const history = {} as never;
    const agent = {} as never;
    const outbound = {} as never;

    return new PlatformChatQueueService(
      config,
      rateLimit,
      history,
      agent,
      outbound,
      pendingTextSender,
      options,
    );
  };

  const getQueueMock = (service: PlatformChatQueueService) =>
    (
      service as unknown as {
        queue: { enqueue: jest.Mock; destroy: jest.Mock };
      }
    ).queue;

  const getPipelineMock = (service: PlatformChatQueueService) =>
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
        getDebounceMs: expect.any(Function) as () => number,
        staleTtlMs: 60 * 60 * 1000,
        cleanupIntervalMs: 15 * 60 * 1000,
      }),
      expect.any(Function) as () => Promise<void>,
      expect.objectContaining({
        onPendingQueued: expect.any(Function) as (
          externalUserId: string,
          text: string,
          seq: number,
        ) => Promise<void>,
        onPendingDropped: expect.any(Function) as (
          externalUserId: string,
        ) => Promise<void>,
      }),
    );

    expect(ChatPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes mergedTextMaxChars + typing onStep hook when configured (discord)', async () => {
    const typingIndicator = jest.fn().mockResolvedValue(undefined);

    buildService(undefined, {
      mergedTextMaxChars: 4000,
      typingIndicator,
    });

    expect(ChatPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        onStep: expect.any(Function) as (
          stage: string,
          context: unknown,
        ) => Promise<void>,
      }),
      { mergedTextMaxChars: 4000 },
    );

    const onStep = (
      jest.mocked(ChatPipeline).mock.calls[0][4] as {
        onStep: (stage: string, context: unknown) => Promise<void>;
      }
    ).onStep;
    await onStep('before_agent', { externalUserId: 'discord-1' });
    expect(typingIndicator).toHaveBeenCalledWith('discord-1');

    await onStep('before_send', { externalUserId: 'discord-1' });
    expect(typingIndicator).toHaveBeenCalledTimes(1);
  });

  it('enqueue delegates to queue.enqueue', () => {
    const service = buildService();

    service.enqueue('discord-1', 'hi', { isServerChannel: false }, 'key-1');

    expect(getQueueMock(service).enqueue).toHaveBeenCalledWith({
      externalUserId: 'discord-1',
      text: 'hi',
      context: { isServerChannel: false },
      idempotencyKey: 'key-1',
    });
  });

  it('onModuleDestroy calls queue.destroy', () => {
    const service = buildService();

    service.onModuleDestroy();

    expect(getQueueMock(service).destroy).toHaveBeenCalled();
  });

  it('handleFlush delegates to pipeline.flush with server-channel context (discord)', async () => {
    const service = buildService(undefined, { propagateServerChannel: true });
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
      context: { isServerChannel: false },
    });
  });

  it('handleFlush delegates to pipeline.flush without context (zalo)', async () => {
    const service = buildService();
    const pipeline = getPipelineMock(service);
    const flushCb = getFlushCallback();

    await flushCb({
      externalUserId: 'zalo-1',
      texts: ['hi'],
      context: { userId: 42 },
      idempotencyKey: 'key-1',
    });

    expect(pipeline.flush).toHaveBeenCalledWith({
      externalUserId: 'zalo-1',
      userId: 42,
      texts: ['hi'],
      idempotencyKey: 'key-1',
      context: undefined,
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

  it('sends the pending message when a second message queues while processing', async () => {
    const pendingTextSender = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    buildService(pendingTextSender);

    const callbacks = jest.mocked(DebounceChatQueue).mock.calls[0][2] as {
      onPendingQueued: (
        externalUserId: string,
        text: string,
        seq: number,
      ) => Promise<void>;
      onPendingDropped: (externalUserId: string) => Promise<void>;
    };
    await callbacks.onPendingQueued('discord-1', 'hi', 1);

    expect(pendingTextSender.sendText).toHaveBeenCalledWith(
      'discord-1',
      'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...',
    );
  });

  it('defaults maxPendingSize to 20 when CHAT_MAX_PENDING_MESSAGES is unset', () => {
    buildService();
    const cfg = jest.mocked(DebounceChatQueue).mock.calls[0][0] as {
      maxPendingSize: number;
    };
    expect(cfg.maxPendingSize).toBe(20);
  });

  it('passes no-cap maxPendingSize when CHAT_MAX_PENDING_MESSAGES=0', () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'CHAT_MAX_PENDING_MESSAGES') return '0';
      if (key === 'CHAT_DEBOUNCE_MS') return '2000';
      return undefined;
    });

    buildService();
    const cfg = jest.mocked(DebounceChatQueue).mock.calls[0][0] as {
      maxPendingSize: number;
    };
    expect(cfg.maxPendingSize).toBe(Number.MAX_SAFE_INTEGER);
  });
});
