import { createEnvLlmExecutionPort } from '../execution/env-llm-execution.port';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';

function buildStormAdapter(
  callCount: { total: number },
  maxSuccessBefore: number,
): LlmProviderAdapter {
  return {
    providerName: 'test-storm',
    isConfigured: () => true,
    isRetryableError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes('429') || msg.includes('rate_limit');
    },
    chatWithTools: jest.fn().mockImplementation(async () => {
      callCount.total += 1;
      if (callCount.total <= maxSuccessBefore) {
        throw new Error('429 Too Many Requests');
      }
      return { content: 'ok', toolCalls: [] };
    }),
    chatJson: jest.fn(),
    chatStream: jest.fn(),
  } as unknown as LlmProviderAdapter;
}

const noopLogger = { warn: jest.fn(), error: jest.fn() };
const noopMetrics = {
  incrementCounter: jest.fn(),
  observeWaitSeconds: jest.fn(),
  observeRetryAttempts: jest.fn(),
};

describe('429-storm load test (#514)', () => {
  it('bounds total HTTP calls when all retries fail', async () => {
    const callCount = { total: 0 };
    // maxSuccessBefore=999 means always throw 429
    const adapter = buildStormAdapter(callCount, 999);

    const port = createEnvLlmExecutionPort(
      {
        enabled: true,
        maxConcurrent: 10,
        globalMaxConcurrent: 10,
        maxAttempts: 1,
        baseBackoffMs: 1,
        retryMaxDelayMs: 10,
        requestTimeoutMs: 5_000,
        perAttemptTimeoutMs: 2_000,
        globalConcurrencyEnabled: false,
        maxQueueDepth: 50,
        chatAdmissionWaitMs: 8_000,
        backgroundAdmissionWaitMs: 1_500,
      },
      adapter,
      noopLogger,
      noopMetrics,
    );

    // fn calls adapter.chatWithTools — the adapter throws 429
    await expect(
      port.run((signal) => adapter.chatWithTools({} as never, signal), {
        feature: 'test',
      }),
    ).rejects.toThrow();

    // maxAttempts=1 × failover=2/provider × N providers
    // Total calls bounded — failover tries each provider up to 2 times
    expect(callCount.total).toBeGreaterThanOrEqual(1);
    expect(callCount.total).toBeLessThanOrEqual(10);
  });

  it('records retry attempts metric on exhaustion', async () => {
    const adapter = buildStormAdapter({ total: 0 }, 999);
    const metrics = {
      incrementCounter: jest.fn(),
      observeWaitSeconds: jest.fn(),
      observeRetryAttempts: jest.fn(),
    };

    const port = createEnvLlmExecutionPort(
      {
        enabled: true,
        maxConcurrent: 10,
        globalMaxConcurrent: 10,
        maxAttempts: 1,
        baseBackoffMs: 1,
        retryMaxDelayMs: 10,
        requestTimeoutMs: 5_000,
        perAttemptTimeoutMs: 2_000,
        globalConcurrencyEnabled: false,
        maxQueueDepth: 50,
        chatAdmissionWaitMs: 8_000,
        backgroundAdmissionWaitMs: 1_500,
      },
      adapter,
      noopLogger,
      metrics,
    );

    await expect(
      port.run((signal) => adapter.chatWithTools({} as never, signal), {
        feature: 'test',
      }),
    ).rejects.toThrow();

    expect(metrics.observeRetryAttempts).toHaveBeenCalledWith(1, {
      outcome: 'exhausted',
    });
  });

  it('records successful attempts metric on recovery', async () => {
    // maxSuccessBefore=0 means immediate success (no 429)
    const adapter = buildStormAdapter({ total: 0 }, 0);
    const metrics = {
      incrementCounter: jest.fn(),
      observeWaitSeconds: jest.fn(),
      observeRetryAttempts: jest.fn(),
    };

    const port = createEnvLlmExecutionPort(
      {
        enabled: true,
        maxConcurrent: 10,
        globalMaxConcurrent: 10,
        maxAttempts: 1,
        baseBackoffMs: 1,
        retryMaxDelayMs: 10,
        requestTimeoutMs: 5_000,
        perAttemptTimeoutMs: 2_000,
        globalConcurrencyEnabled: false,
        maxQueueDepth: 50,
        chatAdmissionWaitMs: 8_000,
        backgroundAdmissionWaitMs: 1_500,
      },
      adapter,
      noopLogger,
      metrics,
    );

    const result = await port.run(
      (signal) => adapter.chatWithTools({} as never, signal),
      { feature: 'test' },
    );
    expect(result).toEqual({ content: 'ok', toolCalls: [] });

    expect(metrics.observeRetryAttempts).toHaveBeenCalledWith(1, {
      outcome: 'success',
    });
  });
});
