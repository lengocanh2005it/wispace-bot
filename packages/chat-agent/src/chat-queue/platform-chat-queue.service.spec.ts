import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import { PlatformChatQueueService } from './platform-chat-queue.service';
import type { ChatQueueStorePort } from './chat-queue-store.port';
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

  const buildConfigWith = (
    values: Record<string, string>,
    queueStore?: ChatQueueStorePort,
  ) => {
    const config = {
      get: jest.fn((key: string) => values[key] ?? configGet(key)),
    } as unknown as ConfigService;
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
      { sendText: jest.fn().mockResolvedValue(undefined) },
      {},
      queueStore,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts CHAT_QUEUE_SHARED=true when Redis is available', () => {
    const queueStore = {
      isAvailable: jest.fn().mockReturnValue(true),
      appendChatBuffer: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChatQueueStorePort;

    expect(() =>
      buildConfigWith({ CHAT_QUEUE_SHARED: 'true' }, queueStore),
    ).not.toThrow();
  });

  it('waits for Redis queue availability during module init', async () => {
    let available = false;
    const queueStore = {
      isAvailable: jest.fn(() => available),
      appendChatBuffer: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChatQueueStorePort;
    const service = buildConfigWith({ CHAT_QUEUE_STORE: 'redis' }, queueStore);

    const init = service.onModuleInit();
    available = true;

    await expect(init).resolves.toBeUndefined();
    expect(queueStore.isAvailable).toHaveBeenCalled();
  });

  it('persists the message before reporting Redis enqueue success', async () => {
    const queueStore = {
      isAvailable: jest.fn().mockReturnValue(true),
      appendChatBuffer: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildConfigWith(
      { CHAT_QUEUE_STORE: 'redis' },
      queueStore as unknown as ChatQueueStorePort,
    );

    await service.enqueue(
      'discord-1',
      '  hi  ',
      { userId: 42, isServerChannel: false },
      'key-1',
    );

    expect(queueStore.appendChatBuffer).toHaveBeenCalledWith({
      externalUserId: 'discord-1',
      userText: 'hi',
      userId: 42,
      context: { isServerChannel: false },
      idempotencyKey: 'key-1',
      debounceMs: 2000,
    });
  });

  it('rejects memory queue in production', () => {
    expect(() => buildConfigWith({ NODE_ENV: 'production' })).toThrow(
      /CHAT_QUEUE_STORE=redis is required in production/,
    );
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
      expect.objectContaining({
        onError: expect.any(Function) as (context: unknown) => Promise<void>,
      }),
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
        onError: expect.any(Function) as (context: unknown) => Promise<void>,
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

  it('sends one direct fallback for a queued failure without re-enqueueing', async () => {
    const pendingTextSender = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService(pendingTextSender);
    const hooks = jest.mocked(ChatPipeline).mock.calls[0][4] as {
      onError: (context: {
        externalUserId: string;
        error: Error;
      }) => Promise<void>;
    };

    await hooks.onError({
      externalUserId: 'discord-1',
      error: new Error('LLM failed'),
    });

    expect(pendingTextSender.sendText).toHaveBeenCalledTimes(1);
    expect(pendingTextSender.sendText).toHaveBeenCalledWith(
      'discord-1',
      'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.',
    );
    expect(getQueueMock(service).enqueue).not.toHaveBeenCalled();
  });

  it('distinguishes the original failure from a fallback delivery failure', async () => {
    const originalError = new Error('history failed');
    const fallbackError = new Error('DM unavailable');
    const pendingTextSender = {
      sendText: jest.fn().mockRejectedValue(fallbackError),
    };
    const service = buildService(pendingTextSender);
    const hooks = jest.mocked(ChatPipeline).mock.calls[0][4] as {
      onError: (context: {
        externalUserId: string;
        error: Error;
      }) => Promise<void>;
    };
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      hooks.onError({ externalUserId: 'zalo-1', error: originalError }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('chat_failure phase=original'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('chat_failure phase=fallback_delivery'),
    );
    expect(pendingTextSender.sendText).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    expect(getQueueMock(service).enqueue).not.toHaveBeenCalled();
  });

  it('enqueue delegates to queue.enqueue', async () => {
    const service = buildService();

    await service.enqueue(
      'discord-1',
      'hi',
      { isServerChannel: false },
      'key-1',
    );

    expect(getQueueMock(service).enqueue).toHaveBeenCalledWith({
      externalUserId: 'discord-1',
      text: 'hi',
      context: { isServerChannel: false },
      idempotencyKey: 'key-1',
    });
  });

  it('onModuleDestroy calls queue.destroy', async () => {
    const service = buildService();

    await service.onModuleDestroy();

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

  it('sends the drop notice once per flush cycle', async () => {
    const pendingTextSender = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    buildService(pendingTextSender);

    const callbacks = jest.mocked(DebounceChatQueue).mock.calls[0][2] as {
      onPendingDropped: (externalUserId: string, count: number) => void;
    };

    callbacks.onPendingDropped('discord-1', 5);
    callbacks.onPendingDropped('discord-1', 3);

    expect(pendingTextSender.sendText).toHaveBeenCalledTimes(1);
    expect(pendingTextSender.sendText).toHaveBeenCalledWith(
      'discord-1',
      'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé',
    );

    await getFlushCallback()({
      externalUserId: 'discord-1',
      texts: ['hi'],
      context: {},
      idempotencyKey: 'k',
    });

    callbacks.onPendingDropped('discord-1', 2);
    expect(pendingTextSender.sendText).toHaveBeenCalledTimes(2);
  });

  it('does not notify the user when sendText fails', async () => {
    const pendingTextSender = {
      sendText: jest.fn().mockRejectedValue(new Error('DM unavailable')),
    };
    buildService(pendingTextSender);

    const callbacks = jest.mocked(DebounceChatQueue).mock.calls[0][2] as {
      onPendingDropped: (externalUserId: string, count: number) => void;
    };

    callbacks.onPendingDropped('zalo-1', 4);
    await Promise.resolve();
    expect(pendingTextSender.sendText).toHaveBeenCalledTimes(1);
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
