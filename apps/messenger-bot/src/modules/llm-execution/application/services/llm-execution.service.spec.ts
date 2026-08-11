import type { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import { LlmExecutionService } from './llm-execution.service';

const noopMetrics = {
  timeLlmExecution: <T>(_feature: string, fn: () => Promise<T>) => fn(),
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
  retryMaxAttempts?: number;
  retryBackoffMs?: number;
}): LlmExecutionConfigService {
  const values: Record<string, string> = {};
  if (overrides.enabled !== undefined) {
    values.LLM_EXECUTION_ENABLED = overrides.enabled ? 'true' : 'false';
  }
  if (overrides.maxConcurrent !== undefined) {
    values.LLM_MAX_CONCURRENT = String(overrides.maxConcurrent);
  }
  if (overrides.retryMaxAttempts !== undefined) {
    values.LLM_OPENAI_RETRY_MAX_ATTEMPTS = String(overrides.retryMaxAttempts);
  }
  if (overrides.retryBackoffMs !== undefined) {
    values.LLM_OPENAI_RETRY_BACKOFF_MS = String(overrides.retryBackoffMs);
  }

  return new LlmExecutionConfigService({
    get: (key: string) => values[key],
  } as never);
}

describe('LlmExecutionService', () => {
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
      const metrics = { timeLlmExecution } as unknown as MetricsService;
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
      const metrics = { timeLlmExecution } as unknown as MetricsService;
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
      const metrics = { timeLlmExecution } as unknown as MetricsService;
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
  });
});
