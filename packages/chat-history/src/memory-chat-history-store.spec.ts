import { MemoryChatHistoryStore } from './memory-chat-history-store';

describe('MemoryChatHistoryStore', () => {
  it('returns empty history for unknown user', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('appends user/assistant turns and returns them in order', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
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
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
    await store.appendTurn('u1', '   ', 'reply');
    await store.appendTurn('u1', 'text', '   ');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('caps stored messages at maxMessages, dropping oldest first', async () => {
    const store = new MemoryChatHistoryStore({ ttlMs: 60_000, maxMessages: 4 });
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
    const store = new MemoryChatHistoryStore({ ttlMs: 10, maxMessages: 20 });
    await store.appendTurn('u1', 'hello', 'hi there');

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('clear removes stored history for a user', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
    await store.appendTurn('u1', 'hello', 'hi there');
    await store.clear('u1');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('appends tool summary visible in getHistory', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
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
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );
    await store.appendTurn('u1', 'thanks', 'no problem');

    const history = await store.getHistory('u1');
    expect(history.some((m) => m.role === 'tool_summary')).toBe(false);
  });

  it('clear drops pending tool summaries', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
    await store.appendTurn('u1', 'ask schedule', 'Your schedule is...');
    await store.appendToolSummary(
      'u1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );
    await store.clear('u1');

    await expect(store.getHistory('u1')).resolves.toEqual([]);
  });

  it('keeps histories independent per user', async () => {
    const store = new MemoryChatHistoryStore({
      ttlMs: 60_000,
      maxMessages: 20,
    });
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
});
