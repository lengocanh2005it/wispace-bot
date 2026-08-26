import { DirectUsageWriter } from './direct-usage-writer';

function mockRepo() {
  return {
    insertUsage: jest.fn().mockRejectedValue(new Error('db down')),
  } as any;
}

describe('DirectUsageWriter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries once on failure then logs error', async () => {
    const repo = mockRepo();
    const onError = jest.fn();
    const writer = new DirectUsageWriter(repo, onError);

    writer.write({
      feature: 'chat',
      externalUserId: 'u1',
      model: 'gpt-4',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      usageDate: '2026-08-25',
    });

    await jest.runAllTicks();
    expect(repo.insertUsage).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);
    await jest.runAllTicks();

    expect(repo.insertUsage).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('dispose before catch handler prevents retry', async () => {
    const repo = mockRepo();
    const writer = new DirectUsageWriter(repo);

    writer.write({
      feature: 'chat',
      externalUserId: 'u2',
      model: 'gpt-4',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      usageDate: '2026-08-25',
    });

    writer.dispose();
    await jest.runAllTicks();
    jest.advanceTimersByTime(500);
    await jest.runAllTicks();

    expect(repo.insertUsage).toHaveBeenCalledTimes(1);
  });

  it('dispose after timer scheduled prevents retry from firing', async () => {
    const repo = mockRepo();
    const writer = new DirectUsageWriter(repo);

    writer.write({
      feature: 'chat',
      externalUserId: 'u3',
      model: 'gpt-4',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      usageDate: '2026-08-25',
    });

    // Let the .catch() handler run and schedule the timer
    await jest.runAllTicks();
    expect(repo.insertUsage).toHaveBeenCalledTimes(1);

    // Timer is now scheduled — dispose before it fires
    writer.dispose();
    jest.advanceTimersByTime(500);
    await jest.runAllTicks();

    // Retry callback saw disposed=true, did not call insertUsage
    expect(repo.insertUsage).toHaveBeenCalledTimes(1);
  });
});
