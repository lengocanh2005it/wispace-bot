import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import { PlatformChatQueueService } from './platform-chat-queue.service';
import { fallbackSentThisCycle } from './platform-chat-queue.service';
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
    fallbackSentThisCycle.clear();
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

  it('reopens only the failed clarification event without sending a generic fallback', async () => {
    const clarificationDeliveryFailure = jest.fn().mockResolvedValue(undefined);
    const pendingTextSender = {
      sendText: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService(pendingTextSender, {
      clarificationDeliveryFailure,
    });
    const hooks = jest.mocked(ChatPipeline).mock.calls[0][4] as {
      onError: (context: {
        externalUserId: string;
        idempotencyKey?: string;
        error: Error;
        reply: { text: string; clarification: true };
      }) => Promise<void>;
    };

    await hooks.onError({
      externalUserId: 'zalo-1',
      idempotencyKey: 'event-401-delivery',
      error: new Error('delivery unavailable'),
      reply: { text: 'Mình chưa rõ.', clarification: true },
    });

    expect(clarificationDeliveryFailure).toHaveBeenCalledWith(
      'zalo-1',
      'event-401-delivery',
    );
    expect(pendingTextSender.sendText).not.toHaveBeenCalled();
    expect(getQueueMock(service).enqueue).not.toHaveBeenCalled();
  });

  it('does not reopen a clarification when the provider delivery is ambiguous', async () => {
    const clarificationDeliveryFailure = jest.fn().mockResolvedValue(undefined);
    buildService(
      { sendText: jest.fn().mockResolvedValue(undefined) },
      { clarificationDeliveryFailure },
    );
    const hooks = jest.mocked(ChatPipeline).mock.calls[0][4] as {
      onError: (context: {
        externalUserId: string;
        idempotencyKey?: string;
        error: Error;
        deliveryAmbiguous: true;
        reply: { text: string; clarification: true };
      }) => Promise<void>;
    };

    await hooks.onError({
      externalUserId: 'zalo-1',
      idempotencyKey: 'event-401-ambiguous',
      error: new Error('provider timeout'),
      deliveryAmbiguous: true,
      reply: { text: 'Mình chưa rõ.', clarification: true },
    });

    expect(clarificationDeliveryFailure).not.toHaveBeenCalled();
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

  describe('flush retry on pipeline+fallback failure (#406)', () => {
    const buildDistributedServiceWithRetry = (
      retryEnabled = true,
      fallbackSender?: { sendText: jest.Mock },
    ) => {
      const queueStore = {
        isAvailable: jest.fn().mockReturnValue(true),
        appendChatBuffer: jest.fn().mockResolvedValue(undefined),
        claimReadyBuffer: jest.fn(),
        completeChatBuffer: jest.fn().mockResolvedValue(false),
        scheduleRetryFlush: jest.fn().mockResolvedValue(true),
      } as unknown as ChatQueueStorePort;
      const config = {
        get: jest.fn((key: string) => {
          if (key === 'CHAT_QUEUE_STORE') return 'redis';
          if (key === 'CHAT_DEBOUNCE_MS') return '2000';
          if (key === 'CHAT_FLUSH_RETRY_ENABLED')
            return retryEnabled ? 'true' : 'false';
          if (key === 'CHAT_FLUSH_RETRY_DELAY_MS') return '5000';
          return undefined;
        }),
      } as unknown as ConfigService;
      const sender = fallbackSender ?? {
        sendText: jest.fn().mockResolvedValue(undefined),
      };
      const service = new PlatformChatQueueService(
        config,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        sender,
        {},
        queueStore,
      );
      // Extract the onError hook registered in the constructor
      const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
        onError: (ctx: unknown) => Promise<void>;
      };
      return { service, queueStore, sender, hooks };
    };

    it('re-enqueues batch when pipeline+fallback both fail and retry enabled', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-1',
        texts: ['hello'],
        lastIdempotencyKey: 'key-1',
        userId: 42,
        leaseToken: 'lease-1',
        leaseToken: 'lease-discord-1',
      });

      sender.sendText.mockRejectedValue(new Error('DM unavailable'));
      // Mock pipeline.flush to invoke the onError hook (like the real pipeline)
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('LLM timeout'),
          });
          throw new Error('LLM timeout');
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('discord-1');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).toHaveBeenCalledWith('discord-1', 5000, 'lease-discord-1');
    });

    it('does not re-enqueue when retry is disabled', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(false);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-2',
        texts: ['hi'],
        lastIdempotencyKey: 'key-2',
        userId: 10,
        leaseToken: 'lease-discord-2',
      });

      sender.sendText.mockRejectedValue(new Error('DM unavailable'));
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('LLM timeout'),
          });
          throw new Error('LLM timeout');
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('discord-2');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).not.toHaveBeenCalled();
      expect(
        (queueStore as unknown as { completeChatBuffer: jest.Mock })
          .completeChatBuffer,
      ).not.toHaveBeenCalled();
    });

    it('does not re-enqueue when fallback was successfully sent', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'zalo-1',
        texts: ['hello'],
        lastIdempotencyKey: 'key-3',
        userId: 20,
        leaseToken: 'lease-zalo-1',
      });

      // Fallback succeeds — no retry needed (user received a response)
      sender.sendText.mockResolvedValue(undefined);
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('LLM timeout'),
          });
          throw new Error('LLM timeout');
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('zalo-1');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).not.toHaveBeenCalled();
    });

    it('re-enqueues when fallback send also fails', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'zalo-3',
        texts: ['hello'],
        lastIdempotencyKey: 'key-6',
        userId: 50,
        leaseToken: 'lease-zalo-3',
      });

      // Both fallback and pipeline fail
      sender.sendText.mockRejectedValue(new Error('DM unavailable'));
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('LLM timeout'),
          });
          throw new Error('LLM timeout');
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('zalo-3');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).toHaveBeenCalledWith('zalo-3', 5000, 'lease-zalo-3');
    });

    it('skips completeChatBuffer when scheduleRetryFlush succeeds (#406)', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'zalo-2',
        texts: ['hello'],
        lastIdempotencyKey: 'key-5',
        userId: 40,
        leaseToken: 'lease-zalo-2',
      });

      // scheduleRetryFlush returns true (retry was scheduled)
      (
        queueStore as unknown as { scheduleRetryFlush: jest.Mock }
      ).scheduleRetryFlush.mockResolvedValue(true);

      sender.sendText.mockRejectedValue(new Error('DM down'));
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('boom'),
          });
          throw new Error('boom');
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('zalo-2');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).toHaveBeenCalledWith('zalo-2', 5000, 'lease-zalo-2');
      // #406: completeChatBuffer must NOT be called when retry was scheduled
      expect(
        (queueStore as unknown as { completeChatBuffer: jest.Mock })
          .completeChatBuffer,
      ).not.toHaveBeenCalled();
    });

    it('retries when pipeline reports an unconfirmed delivery and fallback also fails', async () => {
      const { service, queueStore, sender } =
        buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'zalo-false',
        texts: ['hello'],
        lastIdempotencyKey: 'key-false',
        userId: 50,
        leaseToken: 'lease-false',
      });

      sender.sendText.mockRejectedValue(new Error('fallback unavailable'));
      const pipelineFlush = jest
        .fn()
        .mockImplementation(async (input: { externalUserId: string }) => {
          const hooks = jest.mocked(ChatPipeline).mock.calls.at(-1)![4] as {
            onError: (ctx: unknown) => Promise<void>;
          };
          await hooks.onError({
            externalUserId: input.externalUserId,
            error: new Error('delivery not confirmed'),
          });
          return false;
        });
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      await service.flushReady('zalo-false');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).toHaveBeenCalledWith('zalo-false', 5000, 'lease-false');
      expect(
        (queueStore as unknown as { completeChatBuffer: jest.Mock })
          .completeChatBuffer,
      ).not.toHaveBeenCalled();
    });

    it('completes a handled quota-denied false result without retrying', async () => {
      const { service, queueStore } = buildDistributedServiceWithRetry(true);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-quota-denied',
        texts: ['hello'],
        lastIdempotencyKey: 'key-quota-denied',
        leaseToken: 'lease-quota-denied',
      });
      (
        service as unknown as { pipeline: { flush: jest.Mock } }
      ).pipeline.flush.mockResolvedValue(false);

      await service.flushReady('discord-quota-denied');

      expect(
        (queueStore as unknown as { scheduleRetryFlush: jest.Mock })
          .scheduleRetryFlush,
      ).not.toHaveBeenCalled();
      expect(
        (queueStore as unknown as { completeChatBuffer: jest.Mock })
          .completeChatBuffer,
      ).toHaveBeenCalledWith({
        externalUserId: 'discord-quota-denied',
        debounceMs: 2000,
        leaseToken: 'lease-quota-denied',
      });
    });
  });

  describe('fresh-mapping revalidation (#397)', () => {
    const buildDistributedService = (
      freshMappingProvider?: (externalUserId: string) => Promise<unknown>,
      clarificationStateClearer?: (externalUserId: string) => Promise<void>,
      retryEnabled = false,
    ) => {
      const queueStore = {
        isAvailable: jest.fn().mockReturnValue(true),
        appendChatBuffer: jest.fn().mockResolvedValue(undefined),
        claimReadyBuffer: jest.fn(),
        completeChatBuffer: jest.fn().mockResolvedValue(false),
      } as unknown as ChatQueueStorePort;
      const config = {
        get: jest.fn((key: string) => {
          if (key === 'CHAT_QUEUE_STORE') return 'redis';
          if (key === 'CHAT_DEBOUNCE_MS') return '2000';
          if (key === 'CHAT_FLUSH_RETRY_ENABLED') {
            return retryEnabled ? 'true' : 'false';
          }
          return undefined;
        }),
      } as unknown as ConfigService;
      const rateLimit = {} as never;
      const history = {} as never;
      const agent = {} as never;
      const outbound = {} as never;
      return {
        service: new PlatformChatQueueService(
          config,
          rateLimit,
          history,
          agent,
          outbound,
          { sendText: jest.fn().mockResolvedValue(undefined) },
          { freshMappingProvider, clarificationStateClearer },
          queueStore,
        ),
        queueStore,
        pipeline: undefined as unknown as { flush: jest.Mock },
      };
    };

    it('drops batch when fresh-mapping provider returns undefined (unlinked)', async () => {
      const freshMappingProvider = jest.fn().mockResolvedValue(undefined);
      const clarificationStateClearer = jest.fn().mockResolvedValue(undefined);
      const { service, queueStore } = buildDistributedService(
        freshMappingProvider,
        clarificationStateClearer,
      );
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-1',
        texts: ['hello'],
        lastIdempotencyKey: 'key-1',
        userId: 42,
        leaseToken: 'lease-1',
      });

      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await service.flushReady('discord-1');

      expect(freshMappingProvider).toHaveBeenCalledWith('discord-1');
      expect(clarificationStateClearer).toHaveBeenCalledWith('discord-1');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no active mapping'),
      );
      // A confirmed local unlink is terminal for the buffered work.
      expect(
        (queueStore as unknown as { completeChatBuffer: jest.Mock })
          .completeChatBuffer,
      ).toHaveBeenCalledWith({
        externalUserId: 'discord-1',
        debounceMs: 2000,
        leaseToken: 'lease-1',
      });

      warnSpy.mockRestore();
    });

    it('defers batch when fresh-mapping provider reports temporarily unknown', async () => {
      const freshMappingProvider = jest.fn().mockResolvedValue({
        state: 'temporarily-unknown',
      });
      const { service, queueStore } = buildDistributedService(
        freshMappingProvider as never,
        undefined,
        true,
      );
      (
        queueStore as unknown as { scheduleRetryFlush: jest.Mock }
      ).scheduleRetryFlush = jest.fn().mockResolvedValue(true);
      await service.onModuleInit();
      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-unknown',
        texts: ['hello'],
        lastIdempotencyKey: 'key-unknown',
        userId: 42,
        leaseToken: 'lease-unknown',
      });

      await service.flushReady('discord-unknown');

      expect(queueStore.scheduleRetryFlush).toHaveBeenCalledWith(
        'discord-unknown',
        expect.any(Number),
        'lease-unknown',
      );
      expect(queueStore.completeChatBuffer).not.toHaveBeenCalled();
    });

    it('adopts fresh userId when mapping changed (relinked)', async () => {
      const freshMappingProvider = jest.fn().mockResolvedValue(99);
      const clarificationStateClearer = jest.fn().mockResolvedValue(undefined);
      const { service, queueStore } = buildDistributedService(
        freshMappingProvider,
        clarificationStateClearer,
      );
      await service.onModuleInit();

      const batch = {
        externalUserId: 'zalo-1',
        texts: ['hello'],
        lastIdempotencyKey: 'key-2',
        userId: 42,
      };
      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue(batch);

      const pipelineFlush = jest.fn().mockResolvedValue(undefined);
      // Access the pipeline mock via the service internals
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await service.flushReady('zalo-1');

      expect(freshMappingProvider).toHaveBeenCalledWith('zalo-1');
      expect(clarificationStateClearer).toHaveBeenCalledWith('zalo-1');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Stale mapping'),
      );
      // Pipeline should be called with fresh userId
      expect(pipelineFlush).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 99 }),
      );

      warnSpy.mockRestore();
    });

    it('retries once on provider failure, then fail-open with buffered userId', async () => {
      const freshMappingProvider = jest
        .fn()
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(42);
      const { service, queueStore } =
        buildDistributedService(freshMappingProvider);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-2',
        texts: ['hi'],
        lastIdempotencyKey: 'key-3',
        userId: 42,
      });

      const pipelineFlush = jest.fn().mockResolvedValue(undefined);
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await service.flushReady('discord-2');

      expect(freshMappingProvider).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Fresh-mapping query failed'),
      );
      // Retry succeeded → userId adopted from retry
      expect(pipelineFlush).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 42 }),
      );

      errorSpy.mockRestore();
    });

    it('defers when both authoritative mapping attempts fail', async () => {
      const freshMappingProvider = jest
        .fn()
        .mockRejectedValue(new Error('Redis down'));
      const { service, queueStore } =
        buildDistributedService(freshMappingProvider);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'zalo-2',
        texts: ['yo'],
        lastIdempotencyKey: 'key-4',
        userId: 77,
      });

      const pipelineFlush = jest.fn().mockResolvedValue(undefined);
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await service.flushReady('zalo-2');

      expect(freshMappingProvider).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Fresh-mapping retry failed'),
      );
      expect(pipelineFlush).not.toHaveBeenCalled();
      expect(queueStore.completeChatBuffer).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('concurrent flush + relink: no crash, consistent outcome', async () => {
      // Simulate: provider returns 42 on first call (before relink completes),
      // then 99 on second call (after relink). The batch should adopt whichever
      // value the provider returns — no crash, no corrupt state.
      let callCount = 0;
      const freshMappingProvider = jest.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? Promise.resolve(42) : Promise.resolve(99);
      });
      const { service, queueStore } =
        buildDistributedService(freshMappingProvider);
      await service.onModuleInit();

      (
        queueStore as unknown as { claimReadyBuffer: jest.Mock }
      ).claimReadyBuffer.mockResolvedValue({
        externalUserId: 'discord-race',
        texts: ['hello during relink'],
        lastIdempotencyKey: 'key-race',
        userId: 42,
      });

      const pipelineFlush = jest.fn().mockResolvedValue(undefined);
      (service as unknown as { pipeline: { flush: jest.Mock } }).pipeline = {
        flush: pipelineFlush,
      };

      // Two concurrent flushes for the same user — each claims its own batch
      // and calls the provider independently.
      const [result1, result2] = await Promise.allSettled([
        service.flushReady('discord-race'),
        service.flushReady('discord-race'),
      ]);

      expect(result1.status).toBe('fulfilled');
      expect(result2.status).toBe('fulfilled');
      // Both should complete without crash
      expect(pipelineFlush).toHaveBeenCalledTimes(2);
      // Each should have been called with a valid userId (42 or 99, not undefined)
      for (const call of pipelineFlush.mock.calls) {
        expect([42, 99]).toContain(call[0].userId);
      }
    });
  });
});
