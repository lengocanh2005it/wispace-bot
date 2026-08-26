import type { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import { LlmExecutionService } from './llm-execution.service';

const noopMetrics = {
  timeLlmExecution: <T>(_feature: string, fn: () => Promise<T>) => fn(),
  incLlmAdmissionRejected: jest.fn(),
  observeLlmAdmissionWait: jest.fn(),
} as unknown as MetricsService;

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
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter, {
      getNativeClient: () => nativeRedis,
    } as never);
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
    const service = new LlmExecutionService(config, noopMetrics, mockAdapter, {
      getNativeClient: () => nativeRedis,
    } as never);
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
      } as unknown as MetricsService;
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
      } as unknown as MetricsService;
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
      } as unknown as MetricsService;
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
  });
});
