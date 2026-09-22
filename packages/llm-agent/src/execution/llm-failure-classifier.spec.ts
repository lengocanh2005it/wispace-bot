import { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
import { LlmProviderCircuitOpenError } from './circuit-error';
import { LlmOverloadError } from './bounded-admission';
import {
  classifyLlmFailure,
  LlmRetryExhaustedError,
} from './llm-failure-classifier';

describe('classifyLlmFailure (#1380)', () => {
  it('classifies LlmAllProvidersExhaustedError as provider_exhausted', () => {
    const error = new LlmAllProvidersExhaustedError(
      ['openai', 'gemini'],
      new Error('fail'),
    );
    expect(classifyLlmFailure(error)).toBe('provider_exhausted');
  });

  it('classifies LlmProviderCircuitOpenError as provider_circuit_open', () => {
    const error = new LlmProviderCircuitOpenError('open');
    expect(classifyLlmFailure(error)).toBe('provider_circuit_open');
  });

  it('classifies LlmOverloadError as execution_overload', () => {
    const error = new LlmOverloadError('queue_full');
    expect(classifyLlmFailure(error)).toBe('execution_overload');
  });

  it('classifies abort/timeout errors as timeout', () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    expect(classifyLlmFailure(abortErr)).toBe('timeout');

    const timeoutErr = new Error('Timeout');
    timeoutErr.name = 'TimeoutError';
    expect(classifyLlmFailure(timeoutErr)).toBe('timeout');
  });

  it('unwraps LlmRetryExhaustedError cause recursively', () => {
    const rootCause = new LlmOverloadError('global_saturated');
    const retryErr = new LlmRetryExhaustedError(3, rootCause);
    expect(classifyLlmFailure(retryErr)).toBe('execution_overload');

    const nestedRetryErr = new LlmRetryExhaustedError(2, retryErr);
    expect(classifyLlmFailure(nestedRetryErr)).toBe('execution_overload');
  });

  it('classifies LlmRetryExhaustedError with non-Error cause as unknown', () => {
    const retryErr = new LlmRetryExhaustedError(3, 'string cause');
    expect(classifyLlmFailure(retryErr)).toBe('unknown');
  });

  it('classifies arbitrary or non-matching errors as unknown', () => {
    expect(
      classifyLlmFailure(new Error('Sensitive database credentials leaked')),
    ).toBe('unknown');
    expect(classifyLlmFailure(null)).toBe('unknown');
    expect(classifyLlmFailure(undefined)).toBe('unknown');
    expect(classifyLlmFailure({ custom: 'error' })).toBe('unknown');
  });
});
