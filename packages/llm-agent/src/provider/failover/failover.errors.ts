import type { LlmProviderError } from '../types';

export class LlmAllProvidersExhaustedError extends Error {
  constructor(
    public readonly providers: string[],
    public readonly lastError: unknown,
    public readonly failureReasons: readonly LlmProviderError['reason'][] = [],
  ) {
    super(`All LLM providers exhausted (tried: ${providers.join(', ')})`);
    this.name = 'LlmAllProvidersExhaustedError';
  }
}
