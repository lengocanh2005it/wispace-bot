import { createShutdownHandler, type ShutdownDeps } from './graceful-shutdown';

function flush() {
  return Promise.resolve().then(() => Promise.resolve());
}

function buildDeps(overrides: Partial<ShutdownDeps> = {}) {
  const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const deps: ShutdownDeps = {
    app: { close: jest.fn().mockResolvedValue(undefined) },
    shutdownTracing: jest.fn().mockResolvedValue(undefined),
    timeoutMs: 45_000,
    logger,
    exit: jest.fn(),
    ...overrides,
  };
  return { deps, logger };
}

describe('createShutdownHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drains then flushes tracing then exits 0, in order', async () => {
    const { deps, logger } = buildDeps();
    const order: string[] = [];
    (deps.app.close as jest.Mock).mockImplementation(async () => {
      order.push('app.close');
    });
    (deps.shutdownTracing as jest.Mock).mockImplementation(async () => {
      order.push('shutdownTracing');
    });
    (deps.exit as jest.Mock).mockImplementation((code: number) => {
      order.push(`exit:${code}`);
    });

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await flush();

    expect(order).toEqual(['app.close', 'shutdownTracing', 'exit:0']);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
  });

  it('ignores a second signal while shutting down', async () => {
    const { deps } = buildDeps();
    let release!: () => void;
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const shutdown = createShutdownHandler(deps);
    shutdown('SIGTERM');
    await flush();
    shutdown('SIGINT');
    await flush();

    expect(deps.app.close).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await flush();
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('force-exits 1 when drain exceeds the timeout', async () => {
    const { deps } = buildDeps({ timeoutMs: 45_000 });
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>(() => {}),
    );

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await jest.advanceTimersByTimeAsync(45_000);

    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('exits exactly once when the drain finishes after the timeout fired', async () => {
    const { deps } = buildDeps({ timeoutMs: 45_000 });
    let release!: () => void;
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await jest.advanceTimersByTimeAsync(45_000);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);

    // Late drain completion must not call exit a second time.
    release();
    await flush();
    await flush();
    await flush();
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('still flushes tracing when app.close throws, then exits 0', async () => {
    const { deps, logger } = buildDeps();
    (deps.app.close as jest.Mock).mockRejectedValue(new Error('close boom'));

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await flush();
    await flush();

    expect(logger.error.mock.calls[0][0]).toEqual(
      expect.stringContaining('close boom'),
    );
    expect(deps.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
