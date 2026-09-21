import type { BotMetricsService } from '@wispace/bot-metrics';
import { LlmOverloadError } from '@wispace/llm-agent/core';
import type { LlmGlobalConcurrencyPort } from '../ports/llm-global-concurrency.port';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import { LlmExecutionService } from './llm-execution.service';

const noopAdmissionMetrics = {
  incrementCounter: jest.fn(),
  observeWaitSeconds: jest.fn(),
  observeQueueDepth: jest.fn(),
  observeQueueDrainLag: jest.fn(),
  observeExecutionCircuitFailure: jest.fn(),
  observeTotalProviderAttempts: jest.fn(),
};

const noopMetrics = {
  timeLlmExecution: <T>(_feature: string, fn: () => Promise<T>) => fn(),
  incLlmAdmissionRejected: jest.fn(),
  observeLlmAdmissionWait: jest.fn(),
  setLlmAdmissionQueueDepth: jest.fn(),
  setLlmAdmissionDrainLag: jest.fn(),
  llmAdmission: noopAdmissionMetrics,
} as unknown as BotMetricsService;

const mockAdapter = {
  isConfigured: () => true,
  getDefaultModel: () => 'gpt-5.4',
  isRetryableError: (error: unknown) => {
    if (typeof error !== 'object' || error === null) return false;
    const e = error as Record<string, unknown>;
    if (e['name'] === 'RateLimitError') return true;
    const status = e['status'];
    if (status === 429) return true;
    return false;
  },
} as never;

function createGlobalConcurrencyPort(
  nativeRedis: { eval: jest.Mock },
  outcome: 'aborted' | 'saturated',
): LlmGlobalConcurrencyPort {
  return {
    acquire: jest.fn((_limit, _logger, options) => {
      if (outcome === 'aborted') {
        if (options?.signal?.aborted) {
          return Promise.reject(options.signal.reason);
        }
        return Promise.reject(new Error('expected aborted signal'));
      }
      nativeRedis.eval();
      return Promise.reject(new LlmOverloadError('global_saturated'));
    }),
  };
}

function createConfig(overrides: {
  enabled?: boolean;
  maxConcurrent?: number;
  maxQueueDepth?: number;
  chatAdmissionWaitMs?: number;
  backgroundAdmissionWaitMs?: number;
  globalConcurrencyEnabled?: boolean;
  retryMaxAttempts?: number;
  retryBackoffMs?: number;
  requestTimeoutMs?: number;
  perAttemptTimeoutMs?: number;
}): LlmExecutionConfigService {
  const values: Record<string, string> = {};
  if (overrides.enabled !== undefined) {
    values.LLM_EXECUTION_ENABLED = overrides.enabled ? 'true' : 'false';
  }
  if (overrides.maxConcurrent !== undefined) {
    values.LLM_MAX_CONCURRENT = String(overrides.maxConcurrent);
  }
  if (overrides.maxQueueDepth !== undefined) {
    values.LLM_MAX_QUEUE_DEPTH = String(overrides.maxQueueDepth);
  }
  if (overrides.chatAdmissionWaitMs !== undefined) {
    values.LLM_ADMISSION_WAIT_MS = String(overrides.chatAdmissionWaitMs);
  }
  if (overrides.backgroundAdmissionWaitMs !== undefined) {
    values.LLM_BACKGROUND_ADMISSION_WAIT_MS = String(
      overrides.backgroundAdmissionWaitMs,
    );
  }
  if (overrides.globalConcurrencyEnabled !== undefined) {
    values.LLM_GLOBAL_CONCURRENCY_ENABLED = overrides.globalConcurrencyEnabled
      ? 'true'
      : 'false';
  }
  if (overrides.retryMaxAttempts !== undefined) {
    values.LLM_OPENAI_RETRY_MAX_ATTEMPTS = String(overrides.retryMaxAttempts);
  }
  if (overrides.retryBackoffMs !== undefined) {
    values.LLM_OPENAI_RETRY_BACKOFF_MS = String(overrides.retryBackoffMs);
  }
  if (overrides.requestTimeoutMs !== undefined) {
    values.LLM_REQUEST_TIMEOUT_MS = String(overrides.requestTimeoutMs);
  }
  if (overrides.perAttemptTimeoutMs !== undefined) {
    values.LLM_RETRY_PER_ATTEMPT_TIMEOUT_MS = String(
      overrides.perAttemptTimeoutMs,
    );
  }

  return new LlmExecutionConfigService({
    get: (key: string) => values[key],
  } as never);
}

describe('LlmExecutionService', () => {
  it('fails startup when the global budget is enabled without Redis (#389)', () => {
    const config = createConfig({ globalConcurrencyEnabled: true });

    expect(
      () => new LlmExecutionService(config, noopMetrics, mockAdapter),
    ).toThrow(/aggregate limit|Redis/i);
  });

  it('sheds background work with a typed overload before the provider is called (#389)', async () => {
    const config = createConfig({
      enabled: true,
      maxConcurrent: 1,
      backgroundAdmissionWaitMs: 20,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    let releaseHeld!: () => void;
    const held = service.run(
      () =>
        new Promise<string>((resolve) => {
          releaseHeld = () => resolve('held');
        }),
      { feature: 'STUDY_REMINDER' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const inner = jest.fn().mockResolvedValue('never');
    await expect(
      service.run(inner, { feature: 'STUDY_REMINDER' }),
    ).rejects.toMatchObject({
      name: 'LlmOverloadError',
      reason: 'wait_timeout',
    });
    expect(inner).not.toHaveBeenCalled();

    releaseHeld();
    await expect(held).resolves.toBe('held');
  });

  it('composes the caller signal into Redis-global acquisition (#389)', async () => {
    const config = createConfig({ globalConcurrencyEnabled: true });
    const nativeRedis = { eval: jest.fn().mockResolvedValue(1) };
    const service = new LlmExecutionService(
      config,
      noopMetrics,
      mockAdapter,
      createGlobalConcurrencyPort(nativeRedis, 'aborted'),
    );
    const controller = new AbortController();
    controller.abort(new Error('caller gone'));

    await expect(
      service.run(() => Promise.resolve('ok'), {
        feature: 'FREE_FORM_CHAT',
        signal: controller.signal,
      }),
    ).rejects.toThrow('caller gone');
    expect(nativeRedis.eval).not.toHaveBeenCalled();
  });

  it('sheds background work within its bounded budget even under global saturation (#389)', async () => {
    const config = createConfig({ globalConcurrencyEnabled: true });
    const nativeRedis = { eval: jest.fn().mockResolvedValue(0) }; // saturated
    const service = new LlmExecutionService(
      config,
      noopMetrics,
      mockAdapter,
      createGlobalConcurrencyPort(nativeRedis, 'saturated'),
    );
    const startedAt = Date.now();

    await expect(
      service.run(() => Promise.resolve('ok'), { feature: 'STUDY_REMINDER' }),
    ).rejects.toMatchObject({ reason: 'global_saturated' });

    // Legacy loop was ~10s; the admission budget must bound it near 1.5s.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 10_000);

  it('bypasses the limiter when execution gate is disabled', async () => {
    const config = createConfig({ enabled: false, maxConcurrent: 1 });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return 'ok';
    };

    const results = await Promise.all([service.run(task), service.run(task)]);

    expect(results).toEqual(['ok', 'ok']);
    expect(maxConcurrent).toBe(2);
  });

  it('caps concurrent runs when enabled', async () => {
    const config = createConfig({ enabled: true, maxConcurrent: 1 });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return 'ok';
    };

    const results = await Promise.all([service.run(task), service.run(task)]);

    expect(results).toEqual(['ok', 'ok']);
    expect(maxConcurrent).toBe(1);
  });

  it('retries OpenAI 429 before failing', async () => {
    const config = createConfig({
      enabled: true,
      maxConcurrent: 3,
      retryMaxAttempts: 3,
      retryBackoffMs: 1,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    let attempts = 0;

    const result = await service.run(() => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('OpenAI rate limit'), {
          name: 'RateLimitError',
          status: 429,
        });
      }
      return Promise.resolve('success');
    });

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    const config = createConfig({
      enabled: true,
      maxConcurrent: 3,
      retryMaxAttempts: 3,
      retryBackoffMs: 1,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    let attempts = 0;

    await expect(
      service.run(() => {
        attempts += 1;
        return Promise.reject(new Error('validation failed'));
      }),
    ).rejects.toThrow('validation failed');

    expect(attempts).toBe(1);
  });

  it('returns a typed circuit-open error after Opossum opens', async () => {
    const config = createConfig({
      enabled: true,
      retryMaxAttempts: 1,
      retryBackoffMs: 1,
      requestTimeoutMs: 1_000,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    const providerCall = jest
      .fn()
      .mockRejectedValue(new Error('provider down'));

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        service.run(providerCall, { feature: 'STUDENT_REPORT' }),
      ).rejects.toThrow('provider down');
    }

    await expect(
      service.run(providerCall, { feature: 'STUDENT_REPORT' }),
    ).rejects.toMatchObject({
      name: 'LlmProviderCircuitOpenError',
      state: 'open',
    });
    expect(providerCall).toHaveBeenCalledTimes(3);
  });

  it('keeps Opossum closed for repeated bad_request failures and records each terminal execution', async () => {
    const observeFailure = jest.fn();
    const metrics = {
      ...noopMetrics,
      llmAdmission: {
        ...noopAdmissionMetrics,
        observeExecutionCircuitFailure: observeFailure,
      },
    } as unknown as BotMetricsService;
    const config = createConfig({
      enabled: true,
      retryMaxAttempts: 1,
      requestTimeoutMs: 1_000,
    });
    const service = new LlmExecutionService(config, metrics, mockAdapter);
    const providerCall = jest.fn().mockRejectedValue({
      provider: 'openai',
      retryable: false,
      reason: 'bad_request',
      status: 400,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
      ).rejects.toMatchObject({ reason: 'bad_request' });
    }

    expect(providerCall).toHaveBeenCalledTimes(4);
    expect(observeFailure).toHaveBeenCalledTimes(4);
    expect(observeFailure).toHaveBeenCalledWith('bad_request');
  });

  it.each([
    'server_error',
    'rate_limit',
    'quota_exceeded',
    'auth',
    'timeout',
    'network',
    'unknown',
  ] as const)('opens Opossum for %s provider failures', async (reason) => {
    const config = createConfig({
      enabled: true,
      retryMaxAttempts: 1,
      retryBackoffMs: 1,
      requestTimeoutMs: 1_000,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
    const providerCall = jest.fn().mockRejectedValue({
      provider: 'openai',
      retryable: false,
      reason,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
      ).rejects.toMatchObject({ reason });
    }

    await expect(
      service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
    ).rejects.toMatchObject({
      name: 'LlmProviderCircuitOpenError',
      state: 'open',
    });
    expect(providerCall).toHaveBeenCalledTimes(3);
  });

  it('opens Opossum after repeated provider-side attempt timeouts', async () => {
    const timeoutControllers: AbortController[] = [];
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => {
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      });
    try {
      const config = createConfig({
        enabled: true,
        retryMaxAttempts: 1,
        requestTimeoutMs: 100,
        perAttemptTimeoutMs: 5,
      });
      const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
      const providerCall = jest.fn(
        (signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('provider timeout')),
              { once: true },
            );
            timeoutControllers
              .at(-1)
              ?.abort(
                new DOMException('The operation timed out.', 'TimeoutError'),
              );
          }),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
      }

      await expect(
        service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
      ).rejects.toMatchObject({
        name: 'LlmProviderCircuitOpenError',
        state: 'open',
      });
      expect(providerCall).toHaveBeenCalledTimes(3);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('excludes caller cancellation from Opossum failure accounting', async () => {
    const config = createConfig({
      enabled: true,
      retryMaxAttempts: 1,
      requestTimeoutMs: 100,
    });
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const cancelledProvider = jest.fn(() => {
        controller.abort(new Error('caller gone'));
        return Promise.reject(new Error('caller gone'));
      });
      await expect(
        service.run(cancelledProvider, {
          feature: 'FREE_FORM_CHAT',
          signal: controller.signal,
        }),
      ).rejects.toThrow('caller gone');
    }

    const providerFailure = jest
      .fn()
      .mockRejectedValue(new Error('provider down'));
    await expect(
      service.run(providerFailure, { feature: 'FREE_FORM_CHAT' }),
    ).rejects.toThrow('provider down');
    expect(providerFailure).toHaveBeenCalledTimes(1);
  });

  it('counts one Opossum failure per execution, not per retry attempt', async () => {
    jest.useFakeTimers();
    try {
      const config = createConfig({
        enabled: true,
        retryMaxAttempts: 3,
        retryBackoffMs: 1,
        requestTimeoutMs: 30_000,
        perAttemptTimeoutMs: 0,
      });
      const observeFailure = jest.fn();
      const metrics = {
        ...noopMetrics,
        llmAdmission: {
          ...noopAdmissionMetrics,
          observeExecutionCircuitFailure: observeFailure,
        },
      } as unknown as BotMetricsService;
      const service = new LlmExecutionService(config, metrics, mockAdapter);
      const retryableFailure = Object.assign(new Error('rate limit'), {
        status: 429,
      });
      const providerCall = jest.fn().mockRejectedValue(retryableFailure);

      for (let execution = 0; execution < 3; execution += 1) {
        const result = service.run(providerCall, {
          feature: 'FREE_FORM_CHAT',
        });
        const rejection = expect(result).rejects.toThrow('rate limit');
        await jest.advanceTimersByTimeAsync(10);
        await rejection;
      }

      await expect(
        service.run(providerCall, { feature: 'FREE_FORM_CHAT' }),
      ).rejects.toMatchObject({
        name: 'LlmProviderCircuitOpenError',
        state: 'open',
      });
      expect(providerCall).toHaveBeenCalledTimes(9);
      expect(observeFailure).toHaveBeenCalledTimes(3);
      expect(observeFailure).toHaveBeenCalledWith('unknown');
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts an in-flight global deadline in Opossum', async () => {
    const timeoutControllers: AbortController[] = [];
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => {
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      });
    try {
      const config = createConfig({
        enabled: true,
        retryMaxAttempts: 1,
        requestTimeoutMs: 100,
        perAttemptTimeoutMs: 0,
      });
      jest.spyOn(config, 'getPerAttemptTimeoutMs').mockReturnValue(0);
      const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
      const timedOutProvider = jest.fn(
        (signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('deadline')),
              { once: true },
            );
            timeoutControllers
              .at(-1)
              ?.abort(
                new DOMException('The operation timed out.', 'TimeoutError'),
              );
          }),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          service.run(timedOutProvider, { feature: 'FREE_FORM_CHAT' }),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
      }

      await expect(
        service.run(timedOutProvider, { feature: 'FREE_FORM_CHAT' }),
      ).rejects.toMatchObject({
        name: 'LlmProviderCircuitOpenError',
        state: 'open',
      });
      expect(timedOutProvider).toHaveBeenCalledTimes(3);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  describe('metrics — timeLlmExecution', () => {
    it('passes the feature label from context to timeLlmExecution', async () => {
      const config = createConfig({
        enabled: true,
        maxConcurrent: 3,
        retryMaxAttempts: 1,
      });
      const timeLlmExecution = jest.fn(
        <T>(_feature: string, fn: () => Promise<T>) => fn(),
      );
      const metrics = {
        timeLlmExecution,
        incLlmAdmissionRejected: jest.fn(),
        observeLlmAdmissionWait: jest.fn(),
        setLlmAdmissionQueueDepth: jest.fn(),
        setLlmAdmissionDrainLag: jest.fn(),
      } as unknown as BotMetricsService;
      const service = new LlmExecutionService(config, metrics, mockAdapter);

      await service.run(() => Promise.resolve('ok'), {
        feature: 'STUDY_REMINDER',
      });

      expect(timeLlmExecution).toHaveBeenCalledWith(
        'STUDY_REMINDER',
        expect.any(Function),
      );
    });

    it('defaults feature to "unknown" when context is omitted', async () => {
      const config = createConfig({
        enabled: true,
        maxConcurrent: 3,
        retryMaxAttempts: 1,
      });
      const timeLlmExecution = jest.fn(
        <T>(_feature: string, fn: () => Promise<T>) => fn(),
      );
      const metrics = {
        timeLlmExecution,
        incLlmAdmissionRejected: jest.fn(),
        observeLlmAdmissionWait: jest.fn(),
        setLlmAdmissionQueueDepth: jest.fn(),
        setLlmAdmissionDrainLag: jest.fn(),
      } as unknown as BotMetricsService;
      const service = new LlmExecutionService(config, metrics, mockAdapter);

      await service.run(() => Promise.resolve('ok'));

      expect(timeLlmExecution).toHaveBeenCalledWith(
        'unknown',
        expect.any(Function),
      );
    });

    it('calls timeLlmExecution once per attempt on retry', async () => {
      const config = createConfig({
        enabled: true,
        maxConcurrent: 3,
        retryMaxAttempts: 3,
        retryBackoffMs: 1,
      });
      const timeLlmExecution = jest.fn(
        <T>(_feature: string, fn: () => Promise<T>) => fn(),
      );
      const metrics = {
        timeLlmExecution,
        incLlmAdmissionRejected: jest.fn(),
        observeLlmAdmissionWait: jest.fn(),
        setLlmAdmissionQueueDepth: jest.fn(),
        setLlmAdmissionDrainLag: jest.fn(),
      } as unknown as BotMetricsService;
      const service = new LlmExecutionService(config, metrics, mockAdapter);
      let attempts = 0;

      await service.run(
        () => {
          attempts += 1;
          if (attempts < 3) {
            throw Object.assign(new Error('rate limit'), {
              name: 'RateLimitError',
              status: 429,
            });
          }
          return Promise.resolve('ok');
        },
        { feature: 'FREE_FORM_CHAT' },
      );

      expect(timeLlmExecution).toHaveBeenCalledTimes(3);
      expect(timeLlmExecution).toHaveBeenCalledWith(
        'FREE_FORM_CHAT',
        expect.any(Function),
      );
    });
  });

  describe('AbortSignal propagation', () => {
    function createService() {
      const config = createConfig({
        enabled: true,
        maxConcurrent: 1,
        retryMaxAttempts: 3,
        retryBackoffMs: 1,
      });
      return new LlmExecutionService(config, noopMetrics, mockAdapter);
    }

    it('does not invoke fn when the caller signal is pre-aborted', async () => {
      const service = createService();
      const fn = jest.fn().mockResolvedValue('ok');
      const controller = new AbortController();
      controller.abort(new Error('caller gone'));

      await expect(
        service.run(fn, {
          feature: 'STUDENT_REPORT',
          signal: controller.signal,
        }),
      ).rejects.toThrow('caller gone');
      expect(fn).not.toHaveBeenCalled();
    });

    it('stops retrying when the caller signal aborts between attempts', async () => {
      const service = createService();
      const controller = new AbortController();
      let attempts = 0;
      const fn = jest.fn().mockImplementation(() => {
        attempts += 1;
        if (attempts === 1) {
          controller.abort();
          return Promise.reject(
            Object.assign(new Error('rate limit'), {
              name: 'RateLimitError',
              status: 429,
            }),
          );
        }
        return Promise.resolve('ok');
      });

      await expect(
        service.run(fn, {
          feature: 'FREE_FORM_CHAT',
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('passes the composed signal into fn and aborts the in-flight call on deadline (#121)', async () => {
      const config = createConfig({
        enabled: true,
        maxConcurrent: 3,
        retryMaxAttempts: 1,
        requestTimeoutMs: 5,
      });
      const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
      let capturedSignal: AbortSignal | undefined;
      const fn = jest.fn(
        (signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            capturedSignal = signal;
            const timer = setTimeout(resolve, 10_000, 'late');
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

      await expect(
        service.run(fn, { feature: 'STUDY_REMINDER' }),
      ).rejects.toThrow(/timed out|aborted/i);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('composes per-attempt timeout with the shared deadline across retries (#511)', async () => {
      const config = createConfig({
        enabled: true,
        retryMaxAttempts: 2,
        retryBackoffMs: 1,
        requestTimeoutMs: 1_000,
      });
      const service = new LlmExecutionService(config, noopMetrics, mockAdapter);
      const signals: AbortSignal[] = [];
      let attempts = 0;

      await service.run(
        (signal) => {
          signals.push(signal as AbortSignal);
          attempts += 1;
          return attempts === 1
            ? Promise.reject(
                Object.assign(new Error('rate limit'), {
                  name: 'RateLimitError',
                  status: 429,
                }),
              )
            : Promise.resolve('ok');
        },
        { feature: 'STUDENT_REPORT' },
      );

      // Each attempt gets its own composed signal (deadline + per-attempt
      // cap) instead of one shared object — the single deadline still
      // governs because it is part of every composition.
      expect(signals).toHaveLength(2);
      expect(signals[1]).not.toBe(signals[0]);
      for (const signal of signals) {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
      }
    });
  });
});
