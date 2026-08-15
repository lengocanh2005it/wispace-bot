import { MemoryChatHistoryStore } from './memory-chat-history-store';

describe('MemoryChatHistoryStore', () => {
  const stores: MemoryChatHistoryStore[] = [];

  const createStore = (config: Parameters<typeof makeStore>[0]) => {
    const store = makeStore(config);
    stores.push(store);
    return store;
  };

  const makeStore = (config: {
    ttlMs: number;
    maxMessages: number;
    maxUsers?: number;
    pendingSummariesPerUser?: number;
    sweepMs?: number;
  }) => new MemoryChatHistoryStore(config);

  afterEach(() => {
    for (const store of stores) {
      store.dispose();
    }
    stores.length = 0;
    jest.useRealTimers();
  });

  it('returns empty history for unknown user', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('appends user/assistant turns and returns them in order', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');
    await store.appendTurn('u1', 'how are you', 'good');

    await expect(store.getHistory('u1')).resolves.toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you' },
      { role: 'assistant', content: 'good' },
    ]);
  });

  it('ignores turns with blank user or assistant text', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', '   ', 'reply');
    await store.appendTurn('u1', 'text', '   ');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('caps stored messages at maxMessages, dropping oldest first', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 4 });
    await store.appendTurn('u1', 'a', 'a-reply');
    await store.appendTurn('u1', 'b', 'b-reply');
    await store.appendTurn('u1', 'c', 'c-reply');

    await expect(store.getHistory('u1')).resolves.toEqual([
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'b-reply' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'c-reply' },
    ]);
  });

  it('evicts a user history once idle past ttlMs', async () => {
    const store = createStore({ ttlMs: 10, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('treats a stale history as empty on the next append', async () => {
    const store = createStore({ ttlMs: 10, maxMessages: 20 });
    await store.appendTurn('u1', 'old', 'old-reply');

    await new Promise((resolve) => setTimeout(resolve, 20));

    await store.appendTurn('u1', 'new', 'new-reply');
    await expect(store.getHistory('u1')).resolves.toEqual([
      { role: 'user', content: 'new' },
      { role: 'assistant', content: 'new-reply' },
    ]);
  });

  it('clear removes stored history for a user', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');
    await store.clear('u1');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('appends tool summary visible in getHistory', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );

    await expect(store.getHistory('u1')).resolves.toEqual([
      { role: 'user', content: 'ask schedule' },
      { role: 'assistant', content: 'Your schedule is...' },
      {
        role: 'tool_summary',
        content: '[Đã tra cứu: get_upcoming_study_sessions]',
      },
    ]);
  });

  it('drops pending tool summaries when appendTurn is called next', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );
    await store.appendTurn('u1', 'thanks', 'no problem');

    const history = await store.getHistory('u1');
    expect(history.some((m) => m.role === 'tool_summary')).toBe(false);
  });

  it('caps pending tool summaries per user, keeping the newest', async () => {
    const store = createStore({
      ttlMs: 60_000,
      maxMessages: 20,
      pendingSummariesPerUser: 2,
    });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary('u1', 'summary-1');
    await store.appendToolSummary('u1', 'summary-2');
    await store.appendToolSummary('u1', 'summary-3');

    const history = await store.getHistory('u1');
    const summaries = history
      .filter((m) => m.role === 'tool_summary')
      .map((m) => m.content);
    expect(summaries).toEqual(['summary-2', 'summary-3']);
  });

  it('expires pending tool summaries with the TTL', async () => {
    const store = createStore({ ttlMs: 10, maxMessages: 20 });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const history = await store.getHistory('u1');
    expect(history.some((m) => m.role === 'tool_summary')).toBe(false);
  });

  it('clear drops pending tool summaries', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );
    await store.clear('u1');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('keeps histories independent per user', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');
    await store.appendTurn('u2', 'yo', 'sup');

    await expect(store.getHistory('u1')).resolves.toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    await expect(store.getHistory('u2')).resolves.toEqual([
      { role: 'user', content: 'yo' },
      { role: 'assistant', content: 'sup' },
    ]);
  });

  it('sweep evicts users beyond the global cap, oldest first', async () => {
    const store = createStore({
      ttlMs: 60_000,
      maxMessages: 20,
      maxUsers: 2,
      sweepMs: 10,
    });
    await store.appendTurn('u1', 'a', 'a-reply');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendTurn('u2', 'b', 'b-reply');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.appendTurn('u3', 'c', 'c-reply');

    // Wait for the sweep to run and evict the oldest (u1).
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(store.getHistory('u1')).resolves.toEqual([]);
    await expect(store.getHistory('u2')).resolves.not.toEqual([]);
    await expect(store.getHistory('u3')).resolves.not.toEqual([]);
  });

  it('dispose clears all state and stops the timer', async () => {
    const store = createStore({ ttlMs: 60_000, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');

    store.dispose();

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });
});
