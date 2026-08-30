export type LlmProviderCircuitState = 'open' | 'half_open';

export class LlmProviderCircuitOpenError extends Error {
  constructor(readonly state: LlmProviderCircuitState = 'open') {
    super(`LLM provider execution circuit is ${state}`);
    this.name = 'LlmProviderCircuitOpenError';
  }
}
