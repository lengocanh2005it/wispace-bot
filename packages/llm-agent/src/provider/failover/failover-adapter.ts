import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmStreamEvent,
  LlmProviderError,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import { LlmAllProvidersExhaustedError } from './failover.errors';

interface CircuitState {
  healthyAgainAt: number;
}

const COOLDOWN_LONG_MS = 600_000;
const COOLDOWN_SHORT_MS = 5_000;
const QUICK_RETRY_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FailoverCircuitEvent {
  provider: string;
  action: 'open' | 'close' | 'skip';
  reason?: string;
}

export class FailoverLlmProviderAdapter implements LlmProviderAdapter {
  readonly providerName = 'failover';
  private readonly circuit = new Map<string, CircuitState>();
  private readonly cooldownLongMs: number;
  private readonly cooldownShortMs: number;
  private readonly quickRetryDelayMs: number;

  constructor(
    private readonly candidates: LlmProviderAdapter[],
    private readonly logger?: { warn: (msg: string) => void },
    private readonly clock: () => number = Date.now,
    cooldownLongMs?: number,
    cooldownShortMs?: number,
    quickRetryDelayMs?: number,
    private readonly onCircuitEvent?: (event: FailoverCircuitEvent) => void,
  ) {
    this.cooldownLongMs = cooldownLongMs ?? COOLDOWN_LONG_MS;
    this.cooldownShortMs = cooldownShortMs ?? COOLDOWN_SHORT_MS;
    this.quickRetryDelayMs = quickRetryDelayMs ?? QUICK_RETRY_DELAY_MS;
  }

  isConfigured(): boolean {
    return this.candidates.length > 0;
  }

  getDefaultModel(): string {
    return this.candidates[0].getDefaultModel();
  }

  async generateJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    return this.runFailover((c, req) => c.generateJson(req), request);
  }

  async chatWithTools(
    request: LlmToolChatRequest,
  ): Promise<LlmToolChatResponse> {
    return this.runFailover((c, req) => c.chatWithTools(req), request);
  }

  async *chatStream(
    request: LlmToolChatRequest,
  ): AsyncIterable<LlmStreamEvent> {
    const ordered = this.pickHealthy();
    let lastError: unknown;

    for (const candidate of ordered) {
      const req = { ...request, model: candidate.getDefaultModel() };
      try {
        yield* candidate.chatStream(req);
        return; // Stream completed successfully
      } catch (err) {
        lastError = err;
        const { reason } = candidate.normalizeError(err);
        const isFastFail = reason === 'quota_exceeded' || reason === 'auth';
        this.circuit.set(candidate.providerName, {
          healthyAgainAt:
            this.clock() +
            (isFastFail ? this.cooldownLongMs : this.cooldownShortMs),
        });
        this.logger?.warn(
          `LLM_FAILOVER_STREAM provider=${candidate.providerName} reason=${reason} — trying next candidate`,
        );
      }
    }

    throw new LlmAllProvidersExhaustedError(
      ordered.map((c) => c.providerName),
      lastError,
    );
  }

  isRetryableError(): boolean {
    return false;
  }

  isRateLimitError(error: unknown): boolean {
    return this.candidates[0].isRateLimitError(error);
  }

  normalizeError(error: unknown): LlmProviderError {
    return this.candidates[0].normalizeError(error);
  }

  private pickHealthy(): LlmProviderAdapter[] {
    const now = this.clock();
    const healthy = this.candidates.filter(
      (c) => (this.circuit.get(c.providerName)?.healthyAgainAt ?? 0) <= now,
    );
    return healthy.length > 0 ? healthy : this.candidates;
  }

  private async runFailover<Req, Res>(
    call: (c: LlmProviderAdapter, req: Req) => Promise<Res>,
    request: Req & { model?: string },
  ): Promise<Res> {
    const ordered = this.pickHealthy();
    let lastError: unknown;

    for (const candidate of ordered) {
      const req = { ...request, model: candidate.getDefaultModel() };
      const maxAttempts = this.maxAttemptsFor(candidate, undefined);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await call(candidate, req);
          if (this.circuit.has(candidate.providerName)) {
            this.onCircuitEvent?.({
              provider: candidate.providerName,
              action: 'close',
            });
          }
          this.circuit.delete(candidate.providerName);
          return result;
        } catch (err) {
          lastError = err;
          const { reason } = candidate.normalizeError(err);
          const isFastFail = reason === 'quota_exceeded' || reason === 'auth';
          const isLastAttempt = attempt >= maxAttempts;

          if (isFastFail || isLastAttempt) {
            this.circuit.set(candidate.providerName, {
              healthyAgainAt:
                this.clock() +
                (isFastFail ? this.cooldownLongMs : this.cooldownShortMs),
            });
            this.onCircuitEvent?.({
              provider: candidate.providerName,
              action: 'open',
              reason,
            });
            this.logger?.warn(
              `LLM_FAILOVER provider=${candidate.providerName} reason=${reason} attempt=${attempt} — moving to next candidate`,
            );
            break;
          }

          await sleep(this.quickRetryDelayMs);
        }
      }
    }

    throw new LlmAllProvidersExhaustedError(
      ordered.map((c) => c.providerName),
      lastError,
    );
  }

  private maxAttemptsFor(
    _candidate: LlmProviderAdapter,
    lastError: unknown,
  ): number {
    if (!lastError) return 2;
    const { reason } = _candidate.normalizeError(lastError);
    return reason === 'quota_exceeded' || reason === 'auth' ? 1 : 2;
  }
}
