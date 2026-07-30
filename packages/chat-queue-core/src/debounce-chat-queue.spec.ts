import { DebounceChatQueue } from './debounce-chat-queue';
import type { ChatQueueBatch } from './types';

function makeFlushMock<TContext>() {
  return jest.fn<Promise<void>, [ChatQueueBatch<TContext>]>();
}

function makeQueue<TContext = Record<string, unknown>>(
  onFlush: ReturnType<typeof makeFlushMock<TContext>>,
  debounceMs = 20,
  configOverrides?: { maxPendingSize?: number },
) {
  return new DebounceChatQueue<TContext>(
    {
      getDebounceMs: () => debounceMs,
      staleTtlMs: 60_000,
      cleanupIntervalMs: 60_000,
      ...configOverrides,
    },
    onFlush,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('DebounceChatQueue', () => {
  it('flushes a single message after the debounce window', async () => {
    const onFlush =
      makeFlushMock<Record<string, unknown>>().mockResolvedValue(undefined);
    const queue = makeQueue(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: 'hello' });
    await wait(40);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toMatchObject({
      externalUserId: 'u1',
      texts: ['hello'],
    });
    queue.destroy();
  });

  it('merges multiple messages arriving within the debounce window', async () => {
    const onFlush =
      makeFlushMock<Record<string, unknown>>().mockResolvedValue(undefined);
    const queue = makeQueue(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: 'a', idempotencyKey: 'k1' });
    queue.enqueue({ externalUserId: 'u1', text: 'b', idempotencyKey: 'k2' });
    await wait(40);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toMatchObject({
      texts: ['a', 'b'],
      idempotencyKey: 'k2',
    });
    queue.destroy();
  });

  it('ignores blank text', async () => {
    const onFlush =
      makeFlushMock<Record<string, unknown>>().mockResolvedValue(undefined);
    const queue = makeQueue(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: '   ' });
    await wait(40);

    expect(onFlush).not.toHaveBeenCalled();
    queue.destroy();
  });

  it('merges context across enqueues', async () => {
    interface Ctx {
      userId?: number;
      linkContext?: string;
    }
    const onFlush = makeFlushMock<Ctx>().mockResolvedValue(undefined);
    const queue = makeQueue<Ctx>(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: 'a', context: { userId: 5 } });
    queue.enqueue({
      externalUserId: 'u1',
      text: 'b',
      context: { linkContext: 'ctx' },
    });
    await wait(40);

    expect(onFlush.mock.calls[0][0].context).toEqual({
      userId: 5,
      linkContext: 'ctx',
    });
    queue.destroy();
  });

  it('queues messages arriving while a flush is in progress and flushes them after', async () => {
    let resolveFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((resolve) => {
      resolveFirstFlush = resolve;
    });

    const calls: ChatQueueBatch<Record<string, unknown>>[] = [];
    const onFlush = makeFlushMock<Record<string, unknown>>().mockImplementation(
      async (batch) => {
        calls.push(batch);
        if (calls.length === 1) {
          await firstFlushGate;
        }
      },
    );

    const queue = makeQueue(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: 'first' });
    await wait(30); // let first flush start and block on the gate

    queue.enqueue({ externalUserId: 'u1', text: 'second' });
    expect(onFlush).toHaveBeenCalledTimes(1);

    resolveFirstFlush();
    await wait(50); // allow first flush to finish + second batch to debounce-flush

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(calls[1].texts).toEqual(['second']);
    queue.destroy();
  });

  it('flushNow flushes immediately without waiting for the debounce timer', async () => {
    const onFlush =
      makeFlushMock<Record<string, unknown>>().mockResolvedValue(undefined);
    const queue = makeQueue(onFlush, 10_000);

    queue.enqueue({ externalUserId: 'u1', text: 'hello' });
    await queue.flushNow('u1');

    expect(onFlush).toHaveBeenCalledTimes(1);
    queue.destroy();
  });

  it('keeps separate debounce state per user', async () => {
    const onFlush =
      makeFlushMock<Record<string, unknown>>().mockResolvedValue(undefined);
    const queue = makeQueue(onFlush);

    queue.enqueue({ externalUserId: 'u1', text: 'from u1' });
    queue.enqueue({ externalUserId: 'u2', text: 'from u2' });
    await wait(40);

    expect(onFlush).toHaveBeenCalledTimes(2);
    const byUser: Record<string, string[]> = {};
    for (const call of onFlush.mock.calls) {
      byUser[call[0].externalUserId] = call[0].texts;
    }
    expect(byUser.u1).toEqual(['from u1']);
    expect(byUser.u2).toEqual(['from u2']);
    queue.destroy();
  });

  it('calls onPendingQueued when message arrives during processing', async () => {
    let resolveFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((r) => {
      resolveFirstFlush = r;
    });

    const onFlush = makeFlushMock<Record<string, unknown>>().mockImplementation(
      async () => {
        await firstFlushGate;
      },
    );

    const onPendingQueued = jest.fn();
    const queueWithCallbacks = new DebounceChatQueue<Record<string, unknown>>(
      {
        getDebounceMs: () => 20,
        staleTtlMs: 60_000,
        cleanupIntervalMs: 60_000,
      },
      onFlush,
      { onPendingQueued },
    );

    queueWithCallbacks.enqueue({ externalUserId: 'u1', text: 'first' });
    await wait(30);

    queueWithCallbacks.enqueue({ externalUserId: 'u1', text: 'second' });
    queueWithCallbacks.enqueue({ externalUserId: 'u1', text: 'third' });

    expect(onPendingQueued).toHaveBeenCalledTimes(2);
    expect(onPendingQueued).toHaveBeenCalledWith('u1', 'second', 1, undefined);
    expect(onPendingQueued).toHaveBeenCalledWith('u1', 'third', 2, undefined);

    resolveFirstFlush();
    await wait(50);
    queueWithCallbacks.destroy();
  });

  it('calls onPendingDropped when maxPendingSize is exceeded', async () => {
    let resolveFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((r) => {
      resolveFirstFlush = r;
    });

    const onFlush = makeFlushMock<Record<string, unknown>>().mockImplementation(
      async () => {
        await firstFlushGate;
      },
    );

    const onPendingDropped = jest.fn();
    const queue = new DebounceChatQueue<Record<string, unknown>>(
      {
        getDebounceMs: () => 20,
        staleTtlMs: 60_000,
        cleanupIntervalMs: 60_000,
        maxPendingSize: 3,
      },
      onFlush,
      { onPendingDropped },
    );

    queue.enqueue({ externalUserId: 'u1', text: 'first' });
    await wait(30);

    queue.enqueue({ externalUserId: 'u1', text: 'p1' });
    queue.enqueue({ externalUserId: 'u1', text: 'p2' });
    queue.enqueue({ externalUserId: 'u1', text: 'p3' });
    queue.enqueue({ externalUserId: 'u1', text: 'p4' });

    expect(onPendingDropped).toHaveBeenCalledTimes(1);
    expect(onPendingDropped).toHaveBeenCalledWith('u1', 1);

    resolveFirstFlush();
    await wait(50);
    queue.destroy();
  });

  it('retains only the newest maxPendingSize messages when cap is exceeded', async () => {
    let resolveFirstFlush!: () => void;
    const firstFlushGate = new Promise<void>((r) => {
      resolveFirstFlush = r;
    });

    const capturedBatches: ChatQueueBatch<Record<string, unknown>>[] = [];
    const onFlush = makeFlushMock<Record<string, unknown>>().mockImplementation(
      async (batch) => {
        capturedBatches.push(batch);
        if (capturedBatches.length === 1) {
          await firstFlushGate;
        }
      },
    );

    const queue = new DebounceChatQueue<Record<string, unknown>>(
      {
        getDebounceMs: () => 20,
        staleTtlMs: 60_000,
        cleanupIntervalMs: 60_000,
        maxPendingSize: 2,
      },
      onFlush,
    );

    queue.enqueue({ externalUserId: 'u1', text: 'first' });
    await wait(30);

    queue.enqueue({ externalUserId: 'u1', text: 'p1' });
    queue.enqueue({ externalUserId: 'u1', text: 'p2' });
    queue.enqueue({ externalUserId: 'u1', text: 'p3' });

    resolveFirstFlush();
    await wait(50);

    expect(capturedBatches).toHaveLength(2);
    expect(capturedBatches[1].texts).toEqual(['p2', 'p3']);
    queue.destroy();
  });
});
