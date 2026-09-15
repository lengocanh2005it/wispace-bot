import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { collectRuntimeSecretValues, registerRuntimeSecrets } from '../masking';
import { loadVaultSecrets } from '../secrets';
import {
  bootstrapBot,
  createShutdownHandler,
  installProcessErrorHandlers,
  resetProcessErrorHandlersForTests,
  type ShutdownDeps,
} from './bot-bootstrap';

jest.mock('@nestjs/core', () => ({
  NestFactory: { create: jest.fn() },
}));

jest.mock('../secrets', () => ({
  ...jest.requireActual('../secrets'),
  loadVaultSecrets: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../masking', () => ({
  ...jest.requireActual('../masking'),
  collectRuntimeSecretValues: jest.fn().mockReturnValue(['runtime-secret-1']),
  registerRuntimeSecrets: jest.fn(),
}));

function flush() {
  return Promise.resolve().then(() => Promise.resolve());
}

function buildShutdownDeps(overrides: Partial<ShutdownDeps> = {}) {
  const logger = { log: jest.fn(), error: jest.fn() };
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

  it('drains, flushes tracing, and exits exactly once', async () => {
    const { deps } = buildShutdownDeps();
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
  });

  it('ignores a second signal while shutdown is in progress', async () => {
    const { deps } = buildShutdownDeps();
    let release!: () => void;
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const shutdown = createShutdownHandler(deps);
    shutdown('SIGTERM');
    await flush();
    shutdown('SIGINT');
    release();
    await flush();
    await flush();

    expect(deps.app.close).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('force-exits with code 1 when the drain exceeds the timeout', async () => {
    const { deps } = buildShutdownDeps({ timeoutMs: 45_000 });
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>(() => {}),
    );

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await jest.advanceTimersByTimeAsync(45_000);

    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('attempts tracing and exits 0 when app.close throws', async () => {
    const { deps, logger } = buildShutdownDeps();
    (deps.app.close as jest.Mock).mockRejectedValue(new Error('close boom'));

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await flush();
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('close boom'),
      expect.anything(),
    );
    expect(deps.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('does not add a tracing-complete log when no tracing hook is configured', async () => {
    const { deps, logger } = buildShutdownDeps();
    delete deps.shutdownTracing;

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await flush();

    expect(logger.log).not.toHaveBeenCalledWith('Tracing shutdown completed');
  });

  it('does not exit a second time when the drain completes after force exit', async () => {
    const { deps } = buildShutdownDeps();
    let release!: () => void;
    (deps.app.close as jest.Mock).mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    createShutdownHandler(deps)('SIGTERM');
    await flush();
    await jest.advanceTimersByTimeAsync(45_000);
    release();
    await flush();
    await flush();

    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});

describe('process error handlers', () => {
  let baselineUnhandledRejection: readonly unknown[] = [];
  let baselineUncaughtException: readonly unknown[] = [];

  beforeEach(() => {
    baselineUnhandledRejection = process.listeners('unhandledRejection');
    baselineUncaughtException = process.listeners('uncaughtException');
  });

  afterEach(() => {
    for (const listener of process.listeners('unhandledRejection')) {
      if (!baselineUnhandledRejection.includes(listener)) {
        process.removeListener('unhandledRejection', listener);
      }
    }
    for (const listener of process.listeners('uncaughtException')) {
      if (!baselineUncaughtException.includes(listener)) {
        process.removeListener('uncaughtException', listener);
      }
    }
    resetProcessErrorHandlersForTests();
  });

  it('logs sanitized unhandled rejections without exiting', () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    installProcessErrorHandlers(logger, exit);

    process.emit(
      'unhandledRejection',
      new Error('Bearer secret-value-123456789'),
      Promise.resolve(),
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled rejection'),
      expect.stringContaining('[REDACTED]'),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs sanitized uncaught exceptions and exits with code 1', () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    installProcessErrorHandlers(logger, exit);

    const error = new Error('Bearer secret-value-123456789');
    process.emit('uncaughtException', error);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Uncaught exception'),
      expect.any(String),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('bootstrapBot', () => {
  let baselineSigterm: readonly unknown[] = [];
  let baselineSigint: readonly unknown[] = [];
  let baselineUnhandledRejection: readonly unknown[] = [];
  let baselineUncaughtException: readonly unknown[] = [];
  let originalPort: string | undefined;

  beforeEach(() => {
    baselineSigterm = process.listeners('SIGTERM');
    baselineSigint = process.listeners('SIGINT');
    baselineUnhandledRejection = process.listeners('unhandledRejection');
    baselineUncaughtException = process.listeners('uncaughtException');
    originalPort = process.env.PORT;
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const listener of process.listeners('SIGTERM')) {
      if (!baselineSigterm.includes(listener)) {
        process.removeListener('SIGTERM', listener);
      }
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!baselineSigint.includes(listener)) {
        process.removeListener('SIGINT', listener);
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!baselineUnhandledRejection.includes(listener)) {
        process.removeListener('unhandledRejection', listener);
      }
    }
    for (const listener of process.listeners('uncaughtException')) {
      if (!baselineUncaughtException.includes(listener)) {
        process.removeListener('uncaughtException', listener);
      }
    }
    resetProcessErrorHandlersForTests();
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    jest.restoreAllMocks();
  });

  it('loads secrets, configures the app, listens, and then installs signal handlers', async () => {
    const events: string[] = [];
    const app = {
      use: jest.fn(() => events.push('use')),
      setGlobalPrefix: jest.fn(() => events.push('prefix')),
      useGlobalPipes: jest.fn(() => events.push('pipes')),
      enableShutdownHooks: jest.fn(() => events.push('hooks')),
      listen: jest.fn(async (port: string | number) => {
        events.push(`listen:${port}`);
      }),
      close: jest.fn().mockResolvedValue(undefined),
    } as unknown as NestExpressApplication;

    (NestFactory.create as jest.Mock).mockImplementation(async () => {
      events.push('create');
      return app;
    });
    (loadVaultSecrets as jest.Mock).mockImplementation(async () => {
      events.push('vault');
      process.env.PORT = '3012';
    });
    (collectRuntimeSecretValues as jest.Mock).mockImplementation(() => {
      events.push('collect');
      return ['runtime-secret-1'];
    });
    (registerRuntimeSecrets as jest.Mock).mockImplementation(() => {
      events.push('register');
    });

    const processOn = jest.spyOn(process, 'on');
    await bootstrapBot({
      appModule: class TestModule {},
      application: 'zalo',
      port: async () => {
        events.push('resolve-port');
        return process.env.PORT ?? 3002;
      },
      rawBody: true,
      configurePlatform: () => {
        events.push('platform');
      },
      loggerName: 'Bootstrap',
      exit: jest.fn(),
    });

    expect(events).toEqual([
      'vault',
      'collect',
      'register',
      'create',
      'platform',
      'use',
      'prefix',
      'pipes',
      'hooks',
      'resolve-port',
      'listen:3012',
    ]);
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('v1', {
      exclude: ['health', 'health/*path', 'metrics'],
    });
    expect(app.useGlobalPipes).toHaveBeenCalledWith(expect.any(Object));
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
    expect(processOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it('fails fast when Vault loading rejects', async () => {
    const error = new Error('vault unavailable');
    (loadVaultSecrets as jest.Mock).mockRejectedValueOnce(error);

    await expect(
      bootstrapBot({
        appModule: class TestModule {},
        application: 'messenger',
        port: 3000,
        exit: jest.fn(),
      }),
    ).rejects.toBe(error);

    expect(NestFactory.create).not.toHaveBeenCalled();
  });
});
