import { shutdownTracing } from './tracing';

describe('shutdownTracing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves after the SDK shuts down cleanly', async () => {
    const shutdown = jest.fn().mockResolvedValue(undefined);
    const logger = { log: jest.fn(), warn: jest.fn() };

    await shutdownTracing({ shutdown, logger });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('shutdown completed'),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns and resolves instead of hanging when shutdown stalls', async () => {
    const shutdown = jest
      .fn()
      .mockImplementation(() => new Promise<void>(() => {}));
    const logger = { log: jest.fn(), warn: jest.fn() };

    const done = shutdownTracing({ shutdown, logger, timeoutMs: 5_000 });
    await jest.advanceTimersByTimeAsync(5_000);
    await done;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
    );
  });

  it('warns and resolves instead of throwing when shutdown rejects', async () => {
    const shutdown = jest.fn().mockRejectedValue(new Error('exporter down'));
    const logger = { log: jest.fn(), warn: jest.fn() };

    await shutdownTracing({ shutdown, logger });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('exporter down'),
    );
  });
});
