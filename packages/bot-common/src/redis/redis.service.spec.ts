import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import type { RedisOperationMetricsPort } from './redis.client.port';
import {
  RedisCommandTimeoutError,
  RedisConnectTimeoutError,
} from './redis.operation.errors';
import { RedisService } from './redis.service';

type TestCommand = {
  name: string;
  promise: Promise<unknown>;
  reject: (error: Error) => void;
};

type MockRedisInstance = {
  options: Record<string, unknown>;
  status: string;
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  ping: jest.Mock;
  eval: jest.Mock;
  multi: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  sendCommand: (command: TestCommand) => Promise<unknown>;
  pendingCommands: Array<{
    name: string;
    promise: Promise<unknown>;
    reject: (error: Error) => void;
  }>;
  commandError?: Error;
};

const mockRedisInstances: MockRedisInstance[] = [];
let mockRedisNextPingError: Error | undefined;
let mockRedisNextConnectError: Error | undefined;
let mockRedisNextConnectEventError: Error | undefined;

jest.mock('ioredis', () => ({
  __esModule: true,
  default: (() => {
    const MockRedis = jest.fn().mockImplementation(function (
      this: MockRedisInstance,
      options: Record<string, unknown>,
    ) {
      this.options = options;
      this.status = 'ready';
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      this.on = jest.fn(
        (event: string, listener: (...args: unknown[]) => void) => {
          const eventListeners = listeners.get(event) ?? new Set();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
          return this;
        },
      );
      this.off = jest.fn(
        (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
          return this;
        },
      );
      this.emit = jest.fn((event: string, ...args: unknown[]) => {
        listeners.get(event)?.forEach((listener) => listener(...args));
        return listeners.has(event);
      });
      const createCommand = (name: string) => {
        let reject!: (error: Error) => void;
        const promise = new Promise<unknown>((_, rejectPromise) => {
          reject = rejectPromise;
        });
        return { name, promise, reject };
      };
      this.ping = jest.fn().mockImplementation(() => {
        if (mockRedisNextPingError) {
          const error = mockRedisNextPingError;
          mockRedisNextPingError = undefined;
          return Promise.reject(error);
        }
        return Promise.resolve('PONG');
      });
      this.eval = jest
        .fn()
        .mockImplementation(() => this.sendCommand(createCommand('eval')));
      this.multi = jest.fn().mockImplementation(() => ({
        exec: jest
          .fn()
          .mockImplementation(() => this.sendCommand(createCommand('exec'))),
      }));
      this.quit = jest.fn().mockResolvedValue('OK');
      this.disconnect = jest.fn();
      this.pendingCommands = [];
      mockRedisInstances.push(this);
    });
    MockRedis.prototype.sendCommand = jest.fn().mockImplementation(function (
      this: MockRedisInstance,
      command: {
        name: string;
        promise: Promise<unknown>;
        reject: (error: Error) => void;
      },
    ) {
      if (
        this.status !== 'ready' &&
        this.options.enableOfflineQueue === false
      ) {
        command.reject(
          new Error(
            "Stream isn't writeable and enableOfflineQueue options is false",
          ),
        );
        return command.promise;
      }
      this.pendingCommands.push(command);
      const originalReject = command.reject;
      command.reject = (error: Error) => {
        const index = this.pendingCommands.indexOf(command);
        if (index >= 0) {
          this.pendingCommands.splice(index, 1);
        }
        originalReject(error);
      };
      if (this.commandError) {
        const error = this.commandError;
        setTimeout(
          () => command.reject(error),
          Number(this.options.commandTimeout),
        );
      }
      return command.promise;
    });
    MockRedis.prototype.connect = jest
      .fn()
      .mockImplementation(function (this: MockRedisInstance) {
        if (this.status === 'reconnecting') {
          this.status = 'ready';
          const pending = this.pendingCommands.splice(0);
          if (this.options.autoResendUnfulfilledCommands !== false) {
            pending.forEach((command) => this.sendCommand(command));
          }
        }
        if (mockRedisNextConnectEventError) {
          const error = mockRedisNextConnectEventError;
          mockRedisNextConnectEventError = undefined;
          this.emit('error', error);
        }
        if (mockRedisNextConnectError) {
          const error = mockRedisNextConnectError;
          mockRedisNextConnectError = undefined;
          return Promise.reject(error);
        }
        return Promise.resolve();
      });
    return MockRedis;
  })(),
}));

describe('RedisService', () => {
  const config = (overrides: Record<string, string | undefined> = {}) =>
    ({
      get: (key: string) =>
        ({
          REDIS_ENABLED: 'true',
          REDIS_TLS: 'true',
          ...overrides,
        })[key],
    }) as unknown as ConfigService;

  const createCommand = (name: string): TestCommand => {
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((_, rejectPromise) => {
      reject = rejectPromise;
    });
    return { name, promise, reject };
  };

  const createMetrics = (): jest.Mocked<RedisOperationMetricsPort> => ({
    incCommandDeadlineExceeded: jest.fn(),
    incConnectDeadlineExceeded: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisInstances.length = 0;
    mockRedisNextPingError = undefined;
    mockRedisNextConnectError = undefined;
    mockRedisNextConnectEventError = undefined;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('applies bounded command and connection options with safe defaults', async () => {
    const service = new RedisService(config(), createMetrics());

    await service.onModuleInit();

    const options = mockRedisInstances.at(-1)?.options;
    expect(options).toMatchObject({
      commandTimeout: 2_000,
      connectTimeout: 5_000,
      socketTimeout: 2_100,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
    });
    expect(options?.retryStrategy).toBeUndefined();
  });

  it('accepts explicit bounded deadlines', async () => {
    const service = new RedisService(
      config({
        REDIS_COMMAND_TIMEOUT_MS: '20',
        REDIS_CONNECT_TIMEOUT_MS: '50',
      }),
      createMetrics(),
    );

    await service.onModuleInit();

    expect(mockRedisInstances.at(-1)?.options).toMatchObject({
      commandTimeout: 20,
      connectTimeout: 50,
      socketTimeout: 120,
    });
  });

  it('rejects commands issued while disconnected instead of queuing them', async () => {
    const service = new RedisService(config(), createMetrics());
    await service.onModuleInit();

    const client = mockRedisInstances.at(-1)!;
    client.status = 'connecting';
    const native = service.getNativeClient() as never as {
      sendCommand: (command: TestCommand) => Promise<unknown>;
    };

    await expect(native.sendCommand(createCommand('get'))).rejects.toThrow(
      'enableOfflineQueue options is false',
    );
  });

  it('does not replay a rejected command when the background connection recovers', async () => {
    const service = new RedisService(config(), createMetrics());
    await service.onModuleInit();

    const client = mockRedisInstances.at(-1)!;
    client.status = 'ready';
    const native = service.getNativeClient() as never as {
      sendCommand: (command: TestCommand) => Promise<unknown>;
      connect: () => Promise<void>;
    };
    const sendCommand = jest.spyOn(native, 'sendCommand');
    const command = createCommand('set');

    const inFlight = native.sendCommand(command);
    client.status = 'reconnecting';
    await native.connect();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(mockRedisInstances.at(-1)?.options).toMatchObject({
      autoResendUnfulfilledCommands: false,
    });
    expect(mockRedisInstances.at(-1)?.options.retryStrategy).toBeUndefined();

    command.reject(new Error('connection closed'));
    await expect(inFlight).rejects.toThrow('connection closed');
  });

  it.each([
    ['0', 'REDIS_COMMAND_TIMEOUT_MS'],
    ['-1', 'REDIS_COMMAND_TIMEOUT_MS'],
    ['1.5', 'REDIS_COMMAND_TIMEOUT_MS'],
    ['60001', 'REDIS_CONNECT_TIMEOUT_MS'],
    ['not-a-number', 'REDIS_CONNECT_TIMEOUT_MS'],
  ])('rejects invalid deadline %s for %s at construction', (value, key) => {
    expect(
      () => new RedisService(config({ [key]: value }), createMetrics()),
    ).toThrow(key);
  });

  it('normalizes a silent command into a typed timeout and records it once', async () => {
    jest.useFakeTimers();
    const metrics = createMetrics();
    const service = new RedisService(
      config({ REDIS_COMMAND_TIMEOUT_MS: '20' }),
      metrics,
    );
    await service.onModuleInit();

    const client = mockRedisInstances.at(-1)!;
    client.commandError = new Error('Command timed out');
    const command = createCommand('get');
    const promise = (
      service.getNativeClient() as never as {
        sendCommand: (command: never) => Promise<unknown>;
      }
    ).sendCommand(command as never);
    const assertion = expect(promise).rejects.toBeInstanceOf(
      RedisCommandTimeoutError,
    );

    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    await expect(promise).rejects.toMatchObject({
      code: 'REDIS_COMMAND_TIMEOUT',
      command: 'get',
    });
    expect(metrics.incCommandDeadlineExceeded).toHaveBeenCalledTimes(1);
    expect(metrics.incCommandDeadlineExceeded).toHaveBeenCalledWith('get');

    command.reject(new Error('socket closed after command timeout'));
    expect(metrics.incCommandDeadlineExceeded).toHaveBeenCalledTimes(1);
  });

  it('normalizes eval and transaction commands through the same transport seam', async () => {
    jest.useFakeTimers();
    const metrics = createMetrics();
    const service = new RedisService(
      config({ REDIS_COMMAND_TIMEOUT_MS: '20' }),
      metrics,
    );
    await service.onModuleInit();

    const client = mockRedisInstances.at(-1)!;
    client.commandError = new Error('Command timed out');
    const native = service.getNativeClient() as never as {
      eval: () => Promise<unknown>;
      multi: () => { exec: () => Promise<unknown> };
    };
    const evalPromise = native.eval();
    const transactionPromise = native.multi().exec();

    const evalAssertion = expect(evalPromise).rejects.toMatchObject({
      code: 'REDIS_COMMAND_TIMEOUT',
      command: 'eval',
    });
    const transactionAssertion = expect(
      transactionPromise,
    ).rejects.toMatchObject({
      code: 'REDIS_COMMAND_TIMEOUT',
      command: 'exec',
    });

    await jest.advanceTimersByTimeAsync(20);
    await evalAssertion;
    await transactionAssertion;
    expect(metrics.incCommandDeadlineExceeded).toHaveBeenCalledTimes(2);
  });

  it('keeps connect timeout, refusal, and caller cancellation distinguishable', async () => {
    jest.useFakeTimers();
    const metrics = createMetrics();
    const service = new RedisService(
      config({ REDIS_COMMAND_TIMEOUT_MS: '20' }),
      metrics,
    );
    await service.onModuleInit();
    const client = mockRedisInstances.at(-1)!;
    const native = service.getNativeClient() as never as {
      sendCommand: (command: TestCommand) => Promise<unknown>;
      connect: () => Promise<void>;
    };

    mockRedisNextConnectError = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    const directConnect = native.connect();
    const directConnectAssertion = expect(directConnect).rejects.toBeInstanceOf(
      RedisConnectTimeoutError,
    );
    await directConnectAssertion;
    expect(metrics.incConnectDeadlineExceeded).toHaveBeenCalledTimes(1);

    const directRefusal = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    mockRedisNextConnectError = directRefusal;
    await expect(native.connect()).rejects.toBe(directRefusal);
    expect(metrics.incConnectDeadlineExceeded).toHaveBeenCalledTimes(1);

    client.commandError = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    const connectPromise = native.sendCommand(createCommand('ping'));
    const connectAssertion = expect(connectPromise).rejects.toBeInstanceOf(
      RedisConnectTimeoutError,
    );
    await jest.advanceTimersByTimeAsync(20);
    await connectAssertion;
    expect(metrics.incConnectDeadlineExceeded).toHaveBeenCalledTimes(2);

    const refusal = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    client.commandError = refusal;
    const refusalPromise = native.sendCommand(createCommand('ping'));
    const refusalAssertion = expect(refusalPromise).rejects.toBe(refusal);
    await jest.advanceTimersByTimeAsync(20);
    await refusalAssertion;

    const abort = Object.assign(new Error('cancelled'), {
      name: 'AbortError',
    });
    client.commandError = abort;
    const abortPromise = native.sendCommand(createCommand('get'));
    const abortAssertion = expect(abortPromise).rejects.toBe(abort);
    await jest.advanceTimersByTimeAsync(20);
    await abortAssertion;
  });

  it('normalizes a native connect timeout event followed by a closed socket', async () => {
    const metrics = createMetrics();
    const service = new RedisService(config(), metrics);
    await service.onModuleInit();

    mockRedisNextConnectEventError = Object.assign(
      new Error('connect ETIMEDOUT'),
      { code: 'ETIMEDOUT' },
    );
    mockRedisNextConnectError = new Error('Connection is closed.');

    const native = service.getNativeClient() as never as {
      connect: () => Promise<void>;
    };
    await expect(native.connect()).rejects.toMatchObject({
      code: 'REDIS_CONNECT_TIMEOUT',
    });
    expect(metrics.incConnectDeadlineExceeded).toHaveBeenCalledTimes(1);
  });

  it('disconnects a client after the initial ping fails', async () => {
    mockRedisNextPingError = new Error('initial ping failed');
    const service = new RedisService(config(), createMetrics());

    await service.onModuleInit();

    expect(mockRedisInstances.at(-1)?.disconnect).toHaveBeenCalledTimes(1);
    expect(service.getNativeClient()).toBeNull();
  });

  it('disconnects when graceful shutdown cannot quit within the client boundary', async () => {
    const service = new RedisService(config(), createMetrics());
    await service.onModuleInit();
    const client = mockRedisInstances.at(-1)!;
    client.quit.mockRejectedValue(new Error('Command timed out'));

    await service.onModuleDestroy();

    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(service.getNativeClient()).toBeNull();
  });

  it('passes certificate validation options to Redis TLS connections', async () => {
    const service = new RedisService({
      get: (key: string) =>
        ({
          REDIS_ENABLED: 'true',
          REDIS_TLS: 'true',
          REDIS_CA: 'trusted-ca',
        })[key],
    } as never);

    await service.onModuleInit();

    expect(IORedis).toHaveBeenCalledWith(
      expect.objectContaining({
        tls: { rejectUnauthorized: true, ca: 'trusted-ca' },
      }),
    );
  });

  it('rejects plaintext Redis outside an explicitly trusted private network', async () => {
    const service = new RedisService({
      get: (key: string) =>
        ({
          REDIS_ENABLED: 'true',
          REDIS_HOST: 'redis.example.com',
          REDIS_TLS: 'false',
        })[key],
    } as never);

    await service.onModuleInit();

    expect(service.isEnabled()).toBe(false);
    expect(IORedis).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: 'redis.example.com' }),
    );
  });
});
