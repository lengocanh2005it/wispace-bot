import fc from 'fast-check';
import { DebounceChatQueue } from './debounce-chat-queue';
import type { ChatQueueBatch } from './types';

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
