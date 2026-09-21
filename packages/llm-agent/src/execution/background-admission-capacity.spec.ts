import {
  calculateBackgroundAdmissionCapacity,
  resolveBackgroundProducerConcurrency,
} from './background-admission-capacity';

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
});
