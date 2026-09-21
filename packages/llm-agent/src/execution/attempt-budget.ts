export const DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS = 6;
export const MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS = 8;

type ProviderAttemptObserver = (inFlight: boolean) => void;

export function normalizeMaxTotalProviderAttempts(
  value: number | undefined,
): number {
  if (
    value !== undefined &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS
  ) {
    return value;
  }
  return DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS;
}

export function readMaxTotalProviderAttempts(
  value: string | undefined,
): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS
  ) {
    throw new Error(
      `LLM_MAX_TOTAL_PROVIDER_ATTEMPTS must be an integer from 1 to ${MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS}`,
    );
  }
  return parsed;
}

/**
 * One shared allowance for actual provider calls within a single generation.
 * Admission, circuit, cooldown, and queue decisions do not consume it.
 */
export class LlmAttemptBudget {
  private used = 0;
  private lastFailure: unknown;
  private readonly providerAttemptObservers =
    new Set<ProviderAttemptObserver>();

  constructor(public readonly maxAttempts: number) {
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS
    ) {
      throw new Error(
        `LLM provider attempt budget must be an integer from 1 to ${MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS}`,
      );
    }
  }

  get attemptsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return this.maxAttempts - this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.maxAttempts;
  }

  canAttempt(): boolean {
    return !this.exhausted;
  }

  /** Consume exactly once immediately before issuing a provider request. */
  consume(): void {
    this.throwIfExhausted();
    this.used += 1;
    for (const observer of this.providerAttemptObservers) {
      observer(true);
    }
  }

  /** Mark the provider request complete without changing the shared budget. */
  completeProviderAttempt(): void {
    for (const observer of this.providerAttemptObservers) {
      observer(false);
    }
  }

  /**
   * Observe actual provider-call boundaries for execution-circuit attribution.
   * The unsubscribe keeps a completed top-level execution from retaining a
   * request-scoped observer.
   */
  observeProviderAttempt(observer: ProviderAttemptObserver): () => void {
    this.providerAttemptObservers.add(observer);
    return () => this.providerAttemptObservers.delete(observer);
  }

  recordFailure(error: unknown): void {
    this.lastFailure = error;
  }

  /** Preserve the existing terminal cause when the shared allowance is spent. */
  throwIfExhausted(): void {
    if (!this.exhausted) return;
    throw (
      this.lastFailure ?? new Error('LLM provider attempt budget exhausted')
    );
  }
}
