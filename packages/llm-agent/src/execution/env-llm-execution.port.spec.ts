import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import {
  createEnvLlmExecutionPort,
  type EnvLlmExecutionConfig,
} from './env-llm-execution.port';

const DEFAULT_CONFIG: EnvLlmExecutionConfig = {
  enabled: true,
  maxConcurrent: 3,
  globalMaxConcurrent: 10,
  maxAttempts: 2,
  baseBackoffMs: 1,
  requestTimeoutMs: 30_000,
  globalConcurrencyEnabled: false,
  redis: null,
};

const noopLogger = { warn: jest.fn() };

function makeAdapter(): LlmProviderAdapter {
  return {
    providerName: 'openai',
    isConfigured: () => true,
    getDefaultModel: () => 'gpt-5.4',
    generateJson: jest.fn(),
    chatWithTools: jest.fn(),
    chatStream: jest.fn(),
    isRetryableError: () => false,
    isRateLimitError: () => false,
    normalizeError: () => ({ provider: 'openai', retryable: false }),
  } as unknown as LlmProviderAdapter;
}

describe('createEnvLlmExecutionPort', () => {
  it('passes the composed deadline signal into the provider call (#121)', async () => {
    const port = createEnvLlmExecutionPort(
      { ...DEFAULT_CONFIG, requestTimeoutMs: 5 },
      makeAdapter(),
      noopLogger,
    );
    let capturedSignal: AbortSignal | undefined;
    const fn = jest.fn(
      (signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          capturedSignal = signal;
          const timer = setTimeout(resolve, 10_000, 'late'); // never fires in time
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error('Aborted'),
              );
            },
            { once: true },
          );
        }),
    );

    await expect(port.run(fn, { feature: 'FREE_FORM_CHAT' })).rejects.toThrow(
      /aborted/i,
    );

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the in-flight call when the caller signal fires (#121)', async () => {
    const port = createEnvLlmExecutionPort(
      DEFAULT_CONFIG,
      makeAdapter(),
      noopLogger,
    );
    const controller = new AbortController();
    const fn = jest.fn(
      (signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error('Aborted'),
              ),
            { once: true },
          );
        }),
    );
    const runPromise = port.run(fn, {
      feature: 'FREE_FORM_CHAT',
      signal: controller.signal,
    });

    controller.abort(new Error('caller cancelled'));
    await expect(runPromise).rejects.toThrow('caller cancelled');
  });

  it('bypasses limiter/retry/deadline when disabled (passthrough)', async () => {
    const port = createEnvLlmExecutionPort(
      { ...DEFAULT_CONFIG, enabled: false },
      makeAdapter(),
      noopLogger,
    );
    const fn = jest.fn((signal?: AbortSignal) => {
      expect(signal).toBeUndefined();
      return Promise.resolve('ok');
    });

    await expect(port.run(fn, { feature: 'FREE_FORM_CHAT' })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retryable errors up to maxAttempts and stops on abort', async () => {
    const rateLimitErr = Object.assign(new Error('rate limit'), {
      status: 429,
    });
    const adapter = makeAdapter();
    (adapter as { isRetryableError: () => boolean }).isRetryableError = () =>
      true;
    const port = createEnvLlmExecutionPort(
      { ...DEFAULT_CONFIG, maxAttempts: 3, baseBackoffMs: 1 },
      adapter,
      noopLogger,
    );
    let calls = 0;
    const fn = jest.fn((signal?: AbortSignal) => {
      calls += 1;
      if (signal?.aborted) {
        return Promise.reject(
          signal.reason instanceof Error ? signal.reason : new Error('Aborted'),
        );
      }
      if (calls < 3) {
        return Promise.reject(rateLimitErr);
      }
      return Promise.resolve('recovered');
    });

    await expect(port.run(fn, { feature: 'FREE_FORM_CHAT' })).resolves.toBe(
      'recovered',
    );
    expect(calls).toBe(3);
  });

  it('acquires a Redis-distributed slot when enabled and releases after', async () => {
    const redis = {
      incr: jest.fn().mockResolvedValue(1),
      pexpire: jest.fn().mockResolvedValue(1),
      decr: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        globalConcurrencyEnabled: true,
        redis: redis as never,
      },
      makeAdapter(),
      noopLogger,
    );
    const fn = jest.fn(() => Promise.resolve('ok'));

    await expect(port.run(fn, { feature: 'FREE_FORM_CHAT' })).resolves.toBe(
      'ok',
    );

    expect(redis.incr).toHaveBeenCalledWith('llm:concurrency:global');
    expect(redis.pexpire).toHaveBeenCalledWith(
      'llm:concurrency:global',
      60_000,
    );
    expect(redis.decr).toHaveBeenCalledWith('llm:concurrency:global');
  });
});
