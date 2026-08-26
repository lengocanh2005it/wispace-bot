import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import { LlmOverloadError } from './bounded-admission';
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
  maxQueueDepth: 50,
  chatAdmissionWaitMs: 8000,
  backgroundAdmissionWaitMs: 1500,
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
  it('throws at construction when global concurrency is enabled without redis (#389)', () => {
    expect(() =>
      createEnvLlmExecutionPort(
        { ...DEFAULT_CONFIG, globalConcurrencyEnabled: true, redis: null },
        makeAdapter(),
        noopLogger,
      ),
    ).toThrow(/aggregate limit/i);
  });

  it('sheds background features with a typed wait_timeout under saturation (#389)', async () => {
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        maxConcurrent: 1,
        backgroundAdmissionWaitMs: 20,
      },
      makeAdapter(),
      noopLogger,
    );
    const holders: Array<() => void> = [];
    const held = port.run(
      () =>
        new Promise<string>((resolve) => {
          holders.push(() => resolve('held'));
        }),
      { feature: 'STUDENT_REPORT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const queued = port.run(() => Promise.resolve('quick'), {
      feature: 'STUDENT_REPORT',
    });
    await expect(queued).rejects.toBeInstanceOf(LlmOverloadError);
    await expect(queued).rejects.toMatchObject({ reason: 'wait_timeout' });

    holders.forEach((release) => release());
    await expect(held).resolves.toBe('held');
  });

  it('lets interactive chat wait longer than background features (#389)', async () => {
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        maxConcurrent: 1,
        backgroundAdmissionWaitMs: 20,
        chatAdmissionWaitMs: 5_000,
      },
      makeAdapter(),
      noopLogger,
    );
    const holders: Array<() => void> = [];
    const held = port.run(
      () =>
        new Promise<string>((resolve) => {
          holders.push(() => resolve('held'));
        }),
      { feature: 'STUDENT_REPORT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    void port
      .run(() => Promise.resolve('bg'), { feature: 'STUDENT_REPORT' })
      .catch(() => undefined);
    const chat = port.run(() => Promise.resolve('chat'), {
      feature: 'FREE_FORM_CHAT',
    });

    holders.forEach((release) => release());
    await expect(chat).resolves.toBe('chat');
    await expect(held).resolves.toBe('held');
  }, 5_000);

  it('rejects immediately with queue_full when the depth cap is hit (#389)', async () => {
    const port = createEnvLlmExecutionPort(
      { ...DEFAULT_CONFIG, maxConcurrent: 1, maxQueueDepth: 1 },
      makeAdapter(),
      noopLogger,
    );
    const holders: Array<() => void> = [];
    const held = port.run(
      () =>
        new Promise<string>((resolve) => {
          holders.push(() => resolve('held'));
        }),
      { feature: 'FREE_FORM_CHAT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    void port.run(() => Promise.resolve('queued'), {
      feature: 'FREE_FORM_CHAT',
    });

    await expect(
      port.run(() => Promise.resolve('overflow'), {
        feature: 'FREE_FORM_CHAT',
      }),
    ).rejects.toMatchObject({ name: 'LlmOverloadError', reason: 'queue_full' });

    holders.forEach((release) => release());
    await expect(held).resolves.toBe('held');
  });

  it('cancels admission waiting when the caller aborts (#389)', async () => {
    const port = createEnvLlmExecutionPort(
      { ...DEFAULT_CONFIG, maxConcurrent: 1 },
      makeAdapter(),
      noopLogger,
    );
    const controller = new AbortController();
    const holders: Array<() => void> = [];
    const held = port.run(
      () =>
        new Promise<string>((resolve) => {
          holders.push(() => resolve('held'));
        }),
      { feature: 'FREE_FORM_CHAT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const fn = jest.fn(() => Promise.resolve('never'));
    const queued = port.run(fn, {
      feature: 'FREE_FORM_CHAT',
      signal: controller.signal,
    });
    controller.abort(new Error('caller gone'));

    await expect(queued).rejects.toThrow('caller gone');
    expect(fn).not.toHaveBeenCalled();

    holders.forEach((release) => release());
    await expect(held).resolves.toBe('held');
  });

  it('reports typed redis_unavailable instead of silently bypassing the limit (#389)', async () => {
    const redis = { eval: jest.fn().mockRejectedValue(new Error('down')) };
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        globalConcurrencyEnabled: true,
        redis: redis as never,
        globalAcquireMaxRetries: 2,
        globalAcquireRetryDelayMs: 1,
      },
      makeAdapter(),
      noopLogger,
    );

    await expect(
      port.run(() => Promise.resolve('ok'), { feature: 'FREE_FORM_CHAT' }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'redis_unavailable',
    });
  });

  it('reports typed global_saturated when every acquire attempt is denied (#389)', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(0) };
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        globalConcurrencyEnabled: true,
        redis: redis as never,
        globalMaxConcurrent: 10,
        globalAcquireMaxRetries: 2,
        globalAcquireRetryDelayMs: 1,
      },
      makeAdapter(),
      noopLogger,
    );

    await expect(
      port.run(() => Promise.resolve('ok'), { feature: 'FREE_FORM_CHAT' }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'global_saturated',
    });
  });

  it('emits low-cardinality rejection reasons and admission wait metrics (#389)', async () => {
    const incrementCounter = jest.fn();
    const observeWaitSeconds = jest.fn();
    const metrics = { incrementCounter, observeWaitSeconds };
    const port = createEnvLlmExecutionPort(
      {
        ...DEFAULT_CONFIG,
        maxConcurrent: 1,
        backgroundAdmissionWaitMs: 10,
      },
      makeAdapter(),
      noopLogger,
      metrics,
    );
    const holders: Array<() => void> = [];
    const held = port.run(
      () =>
        new Promise<string>((resolve) => {
          holders.push(() => resolve('held'));
        }),
      { feature: 'STUDENT_REPORT' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    void port
      .run(() => Promise.resolve('bg'), { feature: 'STUDENT_REPORT' })
      .catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(incrementCounter).toHaveBeenCalledWith(
      'llm_admission_rejected_total',
      { reason: 'wait_timeout' },
    );

    holders.forEach((release) => release());
    await expect(held).resolves.toBe('held');
    expect(observeWaitSeconds).toHaveBeenCalled();
  });

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
      eval: jest.fn().mockResolvedValue(1),
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

    // acquire (Lua ACQUIRE_SCRIPT) + release (Lua RELEASE_SCRIPT)
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });
});
