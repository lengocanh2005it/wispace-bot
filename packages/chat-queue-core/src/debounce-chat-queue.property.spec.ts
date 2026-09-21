import fc from 'fast-check';
import { DebounceChatQueue } from './debounce-chat-queue';
import type {
  ChatQueueBatch,
  ChatQueueFlushHandler,
  DebounceChatQueueCallbacks,
} from './types';

fc.configureGlobal({ numRuns: 200 });

const COMMAND = fc.record({
  externalUserId: fc.constantFrom<'u1' | 'u2'>('u1', 'u2'),
  text: fc
    .string({ minLength: 1, maxLength: 40 })
    .map((text) => text.trim() || 'x'),
  idempotencyKey: fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
    nil: undefined,
  }),
});

function makeQueue(
  onFlush: (batch: ChatQueueBatch<Record<string, never>>) => Promise<void>,
  maxPendingSize: number,
): DebounceChatQueue<Record<string, never>> {
  return new DebounceChatQueue(
    {
      getDebounceMs: () => 10_000,
      staleTtlMs: 60_000,
      cleanupIntervalMs: 60_000,
      maxPendingSize,
    },
    onFlush,
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('DebounceChatQueue properties', () => {
  it('preserves per-user order and keeps only the newest buffered messages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          commands: fc.array(COMMAND, { minLength: 1, maxLength: 20 }),
          maxPendingSize: fc.integer({ min: 1, max: 5 }),
        }),
        async ({ commands, maxPendingSize }) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const queue = makeQueue(async (batch) => {
            batches.push(batch);
          }, maxPendingSize);

          try {
            const expected = new Map<
              string,
              { texts: string[]; key?: string }
            >();
            for (const command of commands) {
              const current = expected.get(command.externalUserId) ?? {
                texts: [],
              };
              current.texts.push(command.text.trim());
              if (current.texts.length > maxPendingSize) {
                current.texts.splice(0, current.texts.length - maxPendingSize);
              }
              if (command.idempotencyKey) {
                current.key = command.idempotencyKey;
              }
              expected.set(command.externalUserId, current);
              queue.enqueue(command);
            }

            await queue.destroy();

            const actual = new Map<
              string,
              ChatQueueBatch<Record<string, never>>
            >();
            for (const batch of batches) {
              actual.set(batch.externalUserId, batch);
            }
            expect([...actual.keys()].sort()).toEqual(
              [...expected.keys()].sort(),
            );
            for (const [userId, model] of expected) {
              const batch = actual.get(userId);
              expect(batch?.texts).toEqual(model.texts);
              expect(batch?.idempotencyKey).toBe(model.key);
            }
          } finally {
            await queue.destroy();
          }
        },
      ),
    );
  });

  it('promotes the newest capped pending messages after an active flush', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .map((text) => text.trim() || 'x'),
          {
            minLength: 1,
            maxLength: 12,
          },
        ),
        async (pendingTexts) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const firstFlush = deferred<void>();
          const queue = makeQueue(async (batch) => {
            batches.push(batch);
            if (batches.length === 1) {
              await firstFlush.promise;
            }
          }, 3);

          try {
            queue.enqueue({ externalUserId: 'u1', text: 'first' });
            const activeFlush = queue.flushNow('u1');
            await Promise.resolve();

            for (const text of pendingTexts) {
              queue.enqueue({ externalUserId: 'u1', text });
            }

            firstFlush.resolve();
            await activeFlush;
            await queue.drain();

            expect(batches).toHaveLength(2);
            expect(batches[0].texts).toEqual(['first']);
            expect(batches[1].texts).toEqual(
              pendingTexts.slice(-3).map((text) => text.trim()),
            );
          } finally {
            await queue.destroy();
          }
        },
      ),
    );
  });
});

const WINDOW_MS = 100;
const NO_SWEEP_MS = 3_600_000;
const UNCAPPED = 1_000;

function isSubsequence<T>(candidate: T[], source: T[]): boolean {
  let index = 0;
  for (const item of source) {
    if (index < candidate.length && candidate[index] === item) {
      index += 1;
    }
  }
  return index === candidate.length;
}

/**
 * Deterministic-clock properties for the state machine (#1355).
 *
 * The stale sweep is pushed past any time this suite advances, so a scenario's
 * only time source is the debounce window it is meant to pin. Gates are
 * released in `finally` rather than awaiting `destroy()` there, because with a
 * held flush `drain()` polls on a timer that a discarded fake clock will never
 * fire.
 */
describe('DebounceChatQueue clock and conservation properties', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeClockQueue(
    onFlush: ChatQueueFlushHandler<Record<string, never>>,
    maxPendingSize: number,
    callbacks: DebounceChatQueueCallbacks<Record<string, never>> = {},
  ): DebounceChatQueue<Record<string, never>> {
    return new DebounceChatQueue<Record<string, never>>(
      {
        getDebounceMs: () => WINDOW_MS,
        staleTtlMs: NO_SWEEP_MS,
        cleanupIntervalMs: NO_SWEEP_MS,
        maxPendingSize,
      },
      onFlush,
      callbacks,
    );
  }

  it('groups arrivals into exactly the flush rounds the gaps imply, in arrival order', async () => {
    const gaps = [
      [0],
      [0, 0],
      [WINDOW_MS - 1, WINDOW_MS - 1],
      [WINDOW_MS, WINDOW_MS],
      [0, WINDOW_MS, 0],
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 * WINDOW_MS }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (arrivalGaps) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const queue = makeClockQueue(async (batch) => {
            batches.push(batch);
          }, UNCAPPED);

          // Independent oracle: a round closes when the clock has advanced at
          // least one full window since the last message of that round.
          const expected: string[][] = [[]];
          arrivalGaps.forEach((gap, index) => {
            if (gap >= WINDOW_MS && expected[expected.length - 1].length > 0) {
              expected.push([]);
            }
            expected[expected.length - 1].push(`m${index}`);
          });

          for (const [index, gap] of arrivalGaps.entries()) {
            await jest.advanceTimersByTimeAsync(gap);
            queue.enqueue({ externalUserId: 'u1', text: `m${index}` });
          }
          await jest.advanceTimersByTimeAsync(WINDOW_MS);

          expect(batches.map((batch) => batch.texts)).toEqual(
            expected.filter((round) => round.length > 0),
          );
        },
      ),
      { examples: gaps.map((arrivalGaps) => [arrivalGaps]) },
    );
  });

  it('never flushes ahead of the window, however the arrivals are spaced', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: WINDOW_MS - 1 }), {
          minLength: 2,
          maxLength: 15,
        }),
        async (arrivalGaps) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const queue = makeClockQueue(async (batch) => {
            batches.push(batch);
          }, UNCAPPED);

          for (const [index, gap] of arrivalGaps.entries()) {
            await jest.advanceTimersByTimeAsync(gap);
            queue.enqueue({ externalUserId: 'u1', text: `m${index}` });
            expect(batches).toHaveLength(0);
          }
        },
      ),
    );
  });

  it('keeps a learner who keeps typing waiting for every message sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 12 }),
        async (messageCount) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const queue = makeClockQueue(async (batch) => {
            batches.push(batch);
          }, UNCAPPED);

          // #1111: the window has no ceiling, so a burst spaced one tick under
          // it never flushes. Pinned as current behaviour, not fixed here.
          for (let index = 0; index < messageCount; index += 1) {
            await jest.advanceTimersByTimeAsync(WINDOW_MS - 1);
            queue.enqueue({ externalUserId: 'u1', text: `m${index}` });
          }
          expect(batches).toHaveLength(0);

          await jest.advanceTimersByTimeAsync(WINDOW_MS);
          expect(batches.map((batch) => batch.texts)).toEqual([
            Array.from({ length: messageCount }, (_, index) => `m${index}`),
          ]);
        },
      ),
    );
  });

  it('accounts for every message that arrives while a flush is in flight', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxPendingSize: fc.integer({ min: 1, max: 5 }),
          burstSize: fc.integer({ min: 1, max: 16 }),
        }),
        async ({ maxPendingSize, burstSize }) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const dropEvents: number[] = [];
          const gate = deferred<void>();
          let holding = true;
          const queue = makeClockQueue(
            async (batch) => {
              batches.push(batch);
              if (holding) {
                await gate.promise;
              }
            },
            maxPendingSize,
            {
              onPendingDropped: (_externalUserId, droppedCount) => {
                dropEvents.push(droppedCount);
              },
            },
          );

          try {
            queue.enqueue({ externalUserId: 'u1', text: 'warm' });
            const inFlight = queue.flushNow('u1');
            await Promise.resolve();

            const burst = Array.from(
              { length: burstSize },
              (_, index) => `m${index}`,
            );
            for (const text of burst) {
              queue.enqueue({ externalUserId: 'u1', text });
            }

            holding = false;
            gate.resolve();
            await inFlight;
            await jest.advanceTimersByTimeAsync(WINDOW_MS);

            const delivered = batches.flatMap((batch) => batch.texts);
            const expectedDrops = Math.max(0, burstSize - maxPendingSize);

            // One notice per overflowing enqueue, and the excess counts sum to
            // the number of messages that never reach the learner.
            expect(dropEvents.reduce((total, count) => total + count, 0)).toBe(
              expectedDrops,
            );
            expect(dropEvents).toHaveLength(expectedDrops);
            expect(delivered).toEqual([
              'warm',
              ...burst.slice(-maxPendingSize),
            ]);
            // No silent loss and no duplication: every arrival is either
            // delivered or counted as dropped, in arrival order.
            expect(
              delivered.length - 1 + dropEvents.reduce((a, b) => a + b, 0),
            ).toBe(burstSize);
            expect(isSubsequence(delivered.slice(1), burst)).toBe(true);
          } finally {
            holding = false;
            gate.resolve();
          }
        },
      ),
      {
        examples: [
          [{ maxPendingSize: 1, burstSize: 1 }],
          [{ maxPendingSize: 1, burstSize: 2 }],
          [{ maxPendingSize: 5, burstSize: 5 }],
          [{ maxPendingSize: 5, burstSize: 6 }],
        ],
      },
    );
  });

  it('delivers everything accepted before shutdown and rejects only what arrives after', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          beforeShutdown: fc.integer({ min: 1, max: 8 }),
          afterShutdown: fc.integer({ min: 1, max: 8 }),
        }),
        async ({ beforeShutdown, afterShutdown }) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          const rejected: string[] = [];
          const queue = makeClockQueue(
            async (batch) => {
              batches.push(batch);
            },
            UNCAPPED,
            {
              onShutdownRejected: (_externalUserId, text) => {
                rejected.push(text);
              },
            },
          );

          const accepted = Array.from(
            { length: beforeShutdown },
            (_, index) => `b${index}`,
          );
          for (const text of accepted) {
            queue.enqueue({ externalUserId: 'u1', text });
          }

          await queue.destroy();

          for (let index = 0; index < afterShutdown; index += 1) {
            queue.enqueue({ externalUserId: 'u1', text: `a${index}` });
          }

          expect(batches.flatMap((batch) => batch.texts)).toEqual(accepted);
          expect(rejected).toHaveLength(afterShutdown);
        },
      ),
    );
  });

  it('discards buffered work on clear() without reporting it anywhere', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (messageCount) => {
        const batches: ChatQueueBatch<Record<string, never>>[] = [];
        const dropEvents: number[] = [];
        const rejected: string[] = [];
        const queue = makeClockQueue(
          async (batch) => {
            batches.push(batch);
          },
          UNCAPPED,
          {
            onPendingDropped: () => {
              dropEvents.push(1);
            },
            onShutdownRejected: () => {
              rejected.push('x');
            },
          },
        );

        for (let index = 0; index < messageCount; index += 1) {
          queue.enqueue({ externalUserId: 'u1', text: `m${index}` });
        }
        queue.clear('u1');
        await jest.advanceTimersByTimeAsync(10 * WINDOW_MS);

        // Accepted loss boundary of the memory backend: clear() is how the
        // privacy path drops buffered work, and a dropped message here is
        // deliberately not observable. A distributed backend must not reuse
        // this silence for learner traffic.
        expect(batches).toHaveLength(0);
        expect(dropEvents).toHaveLength(0);
        expect(rejected).toHaveLength(0);
      }),
    );
  });

  it('treats a zero cap as the library default, not as uncapped', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 21, max: 40 }),
        async (messageCount) => {
          const batches: ChatQueueBatch<Record<string, never>>[] = [];
          // types.ts documents `0 = no cap`; the constructor reads 0 as "unset"
          // and falls back to DEFAULT_MAX_PENDING_SIZE (20). Callers that mean
          // uncapped must translate it themselves, as PlatformChatQueueService
          // does. Pinned so the contradiction cannot be resolved silently.
          const capped = new DebounceChatQueue<Record<string, never>>(
            {
              getDebounceMs: () => WINDOW_MS,
              staleTtlMs: NO_SWEEP_MS,
              cleanupIntervalMs: NO_SWEEP_MS,
              maxPendingSize: 0,
            },
            async (batch) => {
              batches.push(batch);
            },
          );

          for (let index = 0; index < messageCount; index += 1) {
            capped.enqueue({ externalUserId: 'u1', text: `m${index}` });
          }
          await jest.advanceTimersByTimeAsync(WINDOW_MS);

          const delivered = batches.flatMap((batch) => batch.texts);
          expect(delivered).toHaveLength(20);
          expect(delivered).toEqual(
            Array.from(
              { length: 20 },
              (_, index) => `m${index + messageCount - 20}`,
            ),
          );
        },
      ),
    );
  });
});
