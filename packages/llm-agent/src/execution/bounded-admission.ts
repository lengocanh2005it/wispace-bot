export type LlmOverloadReason =
  | 'queue_full'
  | 'wait_timeout'
  | 'global_saturated'
  | 'redis_unavailable';

/** Typed overload outcome — callers must distinguish this from provider failure (#389). */
export class LlmOverloadError extends Error {
  readonly reason: LlmOverloadReason;

  constructor(reason: LlmOverloadReason) {
    super(`LLM admission rejected (${reason})`);
    this.name = 'LlmOverloadError';
    this.reason = reason;
  }
}

/**
 * Features that represent interactive user chat. Everything else
 * (reports, reminders) is background work that sheds first under load.
 */
export const INTERACTIVE_LLM_FEATURES: ReadonlySet<string> = new Set([
  'FREE_FORM_CHAT',
]);

export interface AdmissionBudgetConfig {
  chatAdmissionWaitMs: number;
  backgroundAdmissionWaitMs: number;
}

/** Fairness policy (#389 audit follow-up): background work sheds before chat. */
export function admissionWaitBudgetMs(
  config: AdmissionBudgetConfig,
  feature?: string,
): number {
  return feature && INTERACTIVE_LLM_FEATURES.has(feature)
    ? config.chatAdmissionWaitMs
    : config.backgroundAdmissionWaitMs;
}

export interface BoundedAcquireOptions {
  signal?: AbortSignal;
  waitBudgetMs?: number;
}

export interface AdmissionTicket {
  release(): void;
}

/**
 * Resolves with `fn()`'s result as soon as either it settles or the signal
 * fires. The underlying work is NOT cancelled by this wrapper alone — pair
 * it with a real cancellation mechanism when needed (#389).
 */
export async function raceAbort<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) {
    throw rejectionFromSignal(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(rejectionFromSignal(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    fn().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface Waiter {
  resolve: (ticket: AdmissionTicket) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const abortError = (): Error => new DOMException('Aborted', 'AbortError');

/** Preserve the caller's abort reason when it provides one. */
const rejectionFromSignal = (signal?: AbortSignal): Error => {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : abortError();
};

/**
 * Local concurrency gate with an explicit bounded wait queue (#389):
 * - depth cap rejects with `queue_full` immediately,
 * - per-waiter budget rejects with `wait_timeout`,
 * - caller abort cancels the queued wait,
 * - FIFO hand-off on release.
 */
export class BoundedAdmissionQueue {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueueDepth: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  async acquire(options?: BoundedAcquireOptions): Promise<AdmissionTicket> {
    const { signal, waitBudgetMs } = options ?? {};
    if (signal?.aborted) throw rejectionFromSignal(signal);
    if (this.active < this.concurrency) {
      this.active += 1;
      return this.makeTicket();
    }
    if (this.waiters.length >= this.maxQueueDepth) {
      throw new LlmOverloadError('queue_full');
    }

    return new Promise<AdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (waitBudgetMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.remove(waiter);
          reject(new LlmOverloadError('wait_timeout'));
        }, waitBudgetMs);
      }
      if (signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(rejectionFromSignal(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeTicket(): AdmissionTicket {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) {
          this.clearWaiter(next);
          next.resolve(this.makeTicket()); // slot transfers; active unchanged
          return;
        }
        this.active -= 1;
      },
    };
  }

  private remove(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.clearWaiter(waiter);
  }

  private clearWaiter(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }
}
