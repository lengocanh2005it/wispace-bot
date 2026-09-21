import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
import type { LlmProviderError } from '../provider/types';
import {
  createLlmExecutionFailureTracker,
  type LlmExecutionFailureClassification,
} from './failure-attribution';

function makeAdapter(reason: LlmProviderError['reason']): LlmProviderAdapter {
  return {
    providerName: 'openai',
    isConfigured: () => true,
    getDefaultModel: () => 'gpt-5.4',
    generateJson: jest.fn(),
    chatWithTools: jest.fn(),
    isRetryableError: () => false,
    isRateLimitError: () => reason === 'rate_limit',
    normalizeError: () => ({
      provider: 'openai',
      retryable: false,
      reason,
    }),
  } as unknown as LlmProviderAdapter;
}

function makeTracker() {
  return createLlmExecutionFailureTracker({
    deadlineSignal: new AbortController().signal,
  });
}

async function classifyProviderError(
  error: unknown,
  adapter: LlmProviderAdapter,
): Promise<LlmExecutionFailureClassification> {
  const tracker = makeTracker();
  await expect(tracker.run(() => Promise.reject(error))).rejects.toBe(error);
  return tracker.classify(error, adapter);
}

describe('LLM execution failure attribution', () => {
  it('excludes a normalized deterministic request rejection', async () => {
    const error = {
      provider: 'openai',
      retryable: false,
      reason: 'bad_request' as const,
      status: 400,
    };

    await expect(
      classifyProviderError(error, makeAdapter('unknown')),
    ).resolves.toMatchObject({
      kind: 'provider',
      errorClass: 'bad_request',
      countsForCircuit: false,
    });
  });

  it.each([
    'server_error',
    'rate_limit',
    'quota_exceeded',
    'auth',
    'timeout',
    'network',
    'unknown',
  ] as const)('keeps %s as an upstream-health signal', async (reason) => {
    await expect(
      classifyProviderError(new Error(reason), makeAdapter(reason)),
    ).resolves.toMatchObject({
      kind: 'provider',
      errorClass: reason,
      countsForCircuit: true,
    });
  });

  it('excludes an exhausted failover generation when every candidate rejected deterministically', async () => {
    const error = new LlmAllProvidersExhaustedError(
      ['openai', 'openrouter'],
      new Error('invalid request'),
      ['bad_request', 'bad_request'],
    );

    await expect(
      classifyProviderError(error, makeAdapter('unknown')),
    ).resolves.toMatchObject({
      kind: 'provider',
      errorClass: 'bad_request',
      countsForCircuit: false,
    });
  });

  it('counts a failover generation when any candidate reports provider health trouble', async () => {
    const error = new LlmAllProvidersExhaustedError(
      ['openai', 'openrouter'],
      new Error('provider unavailable'),
      ['bad_request', 'server_error'],
    );

    await expect(
      classifyProviderError(error, makeAdapter('unknown')),
    ).resolves.toMatchObject({
      kind: 'provider',
      errorClass: 'server_error',
      countsForCircuit: true,
    });
  });
});
