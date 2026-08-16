import {
  RedisChatHistoryStore,
  type RedisChatHistoryClient,
} from './redis-chat-history-store';

function createStore(client: RedisChatHistoryClient) {
  return new RedisChatHistoryStore(client, {
    ttlSec: 1800,
    maxMessages: 12,
    keyPrefix: 'chat:history:',
  });
}

/**
 * Fake EVAL that executes the read-modify-write exactly like the Redis Lua
 * script does, serialized per call (as Redis serializes script execution).
 * This is what proves #148: when the backing store is atomic, concurrent
 * appends never lose a turn.
 */
function buildAtomicEvalMock() {
  const state = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  const evalMock = jest.fn(
    async (
      _script: string,
      _numKeys: number,
      keys: string[],
      args: Array<string | number>,
    ) => {
      const [max, ttl, payload] = args as [number, number, string];
      queue = queue.then(() => {
        const raw = state.get(keys[0]) ?? null;
        let existing: unknown[] = [];
        if (raw) {
          try {
            const decoded = JSON.parse(raw) as unknown;
            if (Array.isArray(decoded)) existing = decoded;
          } catch {
            existing = [];
          }
        }
        const merged = [
          ...existing,
          ...(JSON.parse(payload) as unknown[]),
        ].slice(-max);
        state.set(keys[0], JSON.stringify(merged));
        void ttl;
      });
      await queue;
      return 1;
    },
  );
  return { evalMock, state };
}

function buildClient(overrides: Partial<RedisChatHistoryClient> = {}) {
  const { evalMock, state } = buildAtomicEvalMock();
  const client = {
    get: jest.fn().mockImplementation(async (key: string) => {
      const value = state.get(key);
      if (overrides.get) return overrides.get(key);
      return value ?? null;
    }),
    set: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    eval: evalMock,
    ...overrides,
  };
  return { client: client, state };
}

describe('RedisChatHistoryStore (#148 atomic appends)', () => {
  it('appends a turn with one atomic EVAL (no GET/SET round trip)', async () => {
    const { client } = buildClient();
    const store = createStore(client);

    await store.appendTurn('psid-1', 'hi', 'hello');

    const evalMock = (client as unknown as { eval: jest.Mock }).eval;
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, keys, args] = evalMock.mock.calls[0] as [
      string,
      number,
      string[],
      Array<string | number>,
    ];
    expect(numKeys).toBe(1);
    expect(keys).toEqual(['chat:history:psid-1']);
    expect(args).toEqual([
      12,
      1800,
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ]);
    // Atomicity: the append must not read or write via separate commands.
    expect(
      (client as unknown as { get: jest.Mock }).get,
    ).not.toHaveBeenCalled();
    expect(
      (client as unknown as { set: jest.Mock }).set,
    ).not.toHaveBeenCalled();
    expect(script).toContain(
      "redis.call('SET', key, cjson.encode(existing), 'EX', ttl)",
    );
  });

  it('appends a tool_summary with one atomic EVAL', async () => {
    const { client, state } = buildClient();
    const store = createStore(client);
    state.set(
      'chat:history:psid-1',
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    );

    await store.appendToolSummary(
      'psid-1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );

    expect(await store.getHistory('psid-1')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      {
        role: 'tool_summary',
        content: '[Đã tra cứu: get_upcoming_study_sessions]',
      },
    ]);
  });

  it('trims to maxMessages inside the atomic append', async () => {
    const { client, state } = buildClient();
    const store = createStore(client);
    const seed = Array.from({ length: 12 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    state.set('chat:history:psid-1', JSON.stringify(seed));

    await store.appendTurn('psid-1', 'hi', 'hello');

    const history = await store.getHistory('psid-1');
    expect(history).toHaveLength(12);
    expect(history.slice(-2)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('#148: concurrent appends for the same user lose no turn', async () => {
    const { client } = buildClient();
    const store = createStore(client);

    const turns = Array.from({ length: 5 }, (_, i) =>
      store.appendTurn('psid-1', `user-${i}`, `assistant-${i}`),
    );
    const summaries = Array.from({ length: 5 }, (_, i) =>
      store.appendToolSummary('psid-1', `summary-${i}`),
    );

    await Promise.all([...turns, ...summaries]);

    const history = await store.getHistory('psid-1');
    // 10 appends, 12-message cap — all entries from the last 6 appends survive
    // and NOTHING written by an earlier append is missing from the tail.
    const contents = history.map((m) => m.content);
    expect(contents).toContain('user-4');
    expect(contents).toContain('assistant-4');
    expect(contents).toContain('summary-4');
    expect(contents).toContain('summary-0');
    // 5 turns = 10 messages + 5 summaries = 15 → trimmed to the last 12.
    expect(history).toHaveLength(12);
    expect(history.filter((m) => m.role === 'tool_summary')).toHaveLength(5);
    // The full ordered tail is present exactly once each — no duplicate/lost.
    const tail = history.slice(-2).map((m) => m.content);
    expect(tail).toEqual(['summary-3', 'summary-4']);
  });

  it('reads and writes history with ttl (existing contract)', async () => {
    const { client, state } = buildClient();
    const store = createStore(client);

    await store.appendTurn('psid-1', 'hi', 'hello');
    expect(await store.getHistory('psid-1')).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(state.has('chat:history:psid-1')).toBe(true);
  });

  it('returns empty when stored payload is not an array', async () => {
    const { client, state } = buildClient();
    state.set('chat:history:psid-1', '{"messages":[]}');
    const store = createStore(client);
    await expect(store.getHistory('psid-1')).resolves.toEqual([]);
  });

  it('clears history key', async () => {
    const { client } = buildClient();
    const store = createStore(client);
    await store.clear('psid-1');

    expect((client as unknown as { del: jest.Mock }).del).toHaveBeenCalledWith(
      'chat:history:psid-1',
    );
  });
});
