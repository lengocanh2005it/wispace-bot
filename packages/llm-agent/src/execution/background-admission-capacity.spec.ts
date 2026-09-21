import {
  calculateBackgroundAdmissionCapacity,
  resolveBackgroundProducerConcurrency,
} from './background-admission-capacity';
import { buildLlmExecutionConfig } from './llm-execution.config';
import { createEnvLlmExecutionPort } from './env-llm-execution.port';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';

const DEFAULTS = {
  maxConcurrent: 3,
  maxQueueDepth: 50,
  backgroundAdmissionWaitMs: 1_500,
  requestTimeoutMs: 30_000,
};

describe('background admission capacity', () => {
  it('derives the documented default capacity from the local queue budget', () => {
    expect(calculateBackgroundAdmissionCapacity(DEFAULTS)).toBe(3);
  });

  it('caps usable queue depth at the configured queue limit', () => {
    expect(
      calculateBackgroundAdmissionCapacity({
        maxConcurrent: 3,
        maxQueueDepth: 2,
        backgroundAdmissionWaitMs: 30_000,
        requestTimeoutMs: 30_000,
      }),
    ).toBe(5);
  });

  it('rejects an explicit producer concurrency above capacity', () => {
    expect(() =>
      resolveBackgroundProducerConcurrency(DEFAULTS, {
        enabled: true,
        producerName: 'report',
        configuredConcurrency: 4,
      }),
    ).toThrow('report concurrency 4 exceeds background admission capacity 3');
  });

  it('keeps the explicit override when execution is disabled and warns', () => {
    const warnings: string[] = [];

    expect(
      resolveBackgroundProducerConcurrency(DEFAULTS, {
        enabled: false,
        producerName: 'report',
        configuredConcurrency: 5,
        onWarning: (message) => warnings.push(message),
      }),
    ).toBe(5);
    expect(warnings).toEqual([
      'LLM execution disabled; report producer cap is not enforced (configured concurrency 5, capacity 3)',
    ]);
  });

  it('warns for the derived producer cap when execution is disabled', () => {
    const warnings: string[] = [];

    expect(
      resolveBackgroundProducerConcurrency(DEFAULTS, {
        enabled: false,
        producerName: 'reminder',
        onWarning: (message) => warnings.push(message),
      }),
    ).toBe(3);
    expect(warnings).toEqual([
      'LLM execution disabled; reminder producer cap is not enforced (configured concurrency 3, capacity 3)',
    ]);
  });

  it('admits a default-config background wave larger than the slot count', async () => {
    const config = buildLlmExecutionConfig(() => undefined);
    const adapter = {
      isRetryableError: () => false,
    } as unknown as LlmProviderAdapter;
    const port = createEnvLlmExecutionPort(config, adapter, {
      warn: jest.fn(),
    });
    const calls = jest.fn(async () => 'ok');

    await expect(
      Promise.all(
        Array.from({ length: config.maxConcurrent + 1 }, () =>
          port.run(() => calls(), { feature: 'STUDENT_REPORT' }),
        ),
      ),
    ).resolves.toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(calls).toHaveBeenCalledTimes(config.maxConcurrent + 1);
  });
});
