import type {
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmProviderError,
} from '../types';
import type { LlmProviderAdapter } from '../llm-provider.adapter';
import { LlmAllProvidersExhaustedError } from './failover.errors';
import { sleep, isAbortError } from '../../utils/retry.utils';

interface CircuitState {
  healthyAgainAt: number;
}

const COOLDOWN_LONG_MS = 600_000;
const COOLDOWN_SHORT_MS = 5_000;
const QUICK_RETRY_DELAY_MS = 150;

export interface FailoverCircuitEvent {
  provider: string;
  action: 'open' | 'close' | 'skip';
  reason?: string;
}

function isProviderErrorShape(error: unknown): error is LlmProviderError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate['provider'] === 'string' &&
    typeof candidate['reason'] === 'string'
  );
}

export class FailoverLlmProviderAdapter implements LlmProviderAdapter {
  readonly providerName = 'failover';
  private readonly circuit = new Map<string, CircuitState>();
  private readonly cooldownLongMs: number;
  private readonly cooldownShortMs: number;
  private readonly quickRetryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly candidates: LlmProviderAdapter[],
    private readonly logger?: { warn: (msg: string) => void },
    private readonly clock: () => number = Date.now,
    cooldownLongMs?: number,
    cooldownShortMs?: number,
    quickRetryDelayMs?: number,
    private readonly onCircuitEvent?: (event: FailoverCircuitEvent) => void,
    private readonly onProviderAttempt?: (
      provider: string,
      feature?: string,
    ) => void,
    private readonly onProvidersExhausted?: (
      providers: string[],
      feature?: string,
    ) => void,
    configuredMaxAttempts?: number,
  ) {
    this.cooldownLongMs = cooldownLongMs ?? COOLDOWN_LONG_MS;
    this.cooldownShortMs = cooldownShortMs ?? COOLDOWN_SHORT_MS;
    this.quickRetryDelayMs = quickRetryDelayMs ?? QUICK_RETRY_DELAY_MS;
    const normalizedMaxAttempts = Number.isFinite(configuredMaxAttempts)
      ? Math.floor(configuredMaxAttempts as number)
      : 2;
    this.maxAttempts = Math.max(1, normalizedMaxAttempts);
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

  isRetryableError(): boolean {
    return false;
  }

  isRateLimitError(error: unknown): boolean {
    // Errors flowing through the failover adapter were classified by the
    // candidate that produced them — the adapters cannot assume homogeneous
    // vendors (#953).
    if (isProviderErrorShape(error)) {
      return error.reason === 'rate_limit';
    }
    return this.candidates[0].isRateLimitError(error);
  }

  normalizeError(error: unknown): LlmProviderError {
    if (isProviderErrorShape(error)) {
      return error;
    }
    return this.candidates[0].normalizeError(error);
  }

  /**
   * Choose the candidates to try, in order.
   *
   * #953: when every provider is cooling down, the full list is retried —
   * failing instantly on a total outage would starve the learner — but the
   * caller runs in `degraded` mode: one attempt per provider instead of the
   * full retry budget, so a total outage costs one call per provider per
   * request. Serialized half-open probes and a probe interval are #581.
   */
  private pickOrdered(): {
    ordered: LlmProviderAdapter[];
    suppressed: LlmProviderAdapter[];
    degraded: boolean;
  } {
    const now = this.clock();
    const healthy = this.candidates.filter(
      (c) => (this.circuit.get(c.providerName)?.healthyAgainAt ?? 0) <= now,
    );
    if (healthy.length === 0) {
      return { ordered: this.candidates, suppressed: [], degraded: true };
    }
    const healthySet = new Set(healthy);
    return {
      ordered: healthy,
      suppressed: this.candidates.filter((c) => !healthySet.has(c)),
      degraded: false,
    };
  }

  /**
   * #953: a provider that is about to be called is not skipped. Emit `skip`
   * only for candidates excluded from the plan; when the degraded fallback
   * runs, nothing is skipped and no skip event is emitted.
   */
  private emitSkips(suppressed: LlmProviderAdapter[]): void {
    for (const candidate of suppressed) {
      this.onCircuitEvent?.({
        provider: candidate.providerName,
        action: 'skip',
        reason: 'cooldown',
      });
    }
  }

  private async runFailover<
    Req extends { signal?: AbortSignal; feature?: string },
    Res,
  >(
    call: (c: LlmProviderAdapter, req: Req) => Promise<Res>,
    request: Req & { model?: string },
  ): Promise<Res> {
    this.validateRequestModelOverride(request.model);
    const { ordered, suppressed, degraded } = this.pickOrdered();
    this.emitSkips(suppressed);
    let lastError: unknown;

    for (const candidate of ordered) {
      if (request.signal?.aborted) {
        throw request.signal.reason ?? new Error('Aborted');
      }
      const req = this.requestForCandidate(request, candidate);
      const maxAttempts = degraded ? 1 : this.maxAttemptsFor(candidate);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new Error('Aborted');
        }
        try {
          this.onProviderAttempt?.(candidate.providerName, request.feature);
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
          if (request.signal?.aborted || isAbortError(err)) {
            throw err;
          }
          const { reason } = candidate.normalizeError(err);
          const isLongCooldown =
            reason === 'quota_exceeded' ||
            reason === 'auth' ||
            reason === 'rate_limit';
          const isLastAttempt = attempt >= maxAttempts;

          if (isLongCooldown || isLastAttempt) {
            this.circuit.set(candidate.providerName, {
              healthyAgainAt:
                this.clock() +
                (isLongCooldown ? this.cooldownLongMs : this.cooldownShortMs),
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

          await sleep(this.quickRetryDelayMs, request.signal);
        }
      }
    }

    const providers = ordered.map((c) => c.providerName);
    this.onProvidersExhausted?.(providers, request.feature);
    throw new LlmAllProvidersExhaustedError(providers, lastError);
  }

  private maxAttemptsFor(_candidate: LlmProviderAdapter): number {
    // #953: the previous per-candidate budget keyed a candidate's attempts
    // on the *previous candidate's* error — dead code (always called with
    // `undefined`) and semantically wrong: quota/auth/rate-limit errors
    // already open a long circuit and break the inner loop after one
    // attempt. The attempt budget is uniform per request.
    return this.maxAttempts;
  }

  private validateRequestModelOverride(model: string | undefined): void {
    if (
      model !== undefined &&
      this.candidates.length > 1 &&
      model.trim() !== this.candidates[0].getDefaultModel()
    ) {
      throw new Error(
        'LLM failover does not accept request model overrides with multiple providers',
      );
    }
  }

  private requestForCandidate<T extends { model?: string }>(
    request: T,
    candidate: LlmProviderAdapter,
  ): T & { model: string } {
    const model =
      this.candidates.length > 1
        ? candidate.getDefaultModel()
        : (request.model ?? candidate.getDefaultModel());
    return { ...request, model };
  }
}
