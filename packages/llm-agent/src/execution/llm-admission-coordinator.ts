import { jitteredDelayMs } from '@wispace/bot-common/utils';
import {
  BoundedAdmissionQueue,
  LlmOverloadError,
  admissionWaitBudgetMs,
  type AdmissionTicket,
} from './bounded-admission';
import type { LlmExecutionAttempt } from '../ports';
import { DEFAULT_MAX_CONSECUTIVE_REDIS_ERRORS } from './redis-slot-limiter';

export interface AdmissionMetrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  observeWaitSeconds(seconds: number): void;
  observeLocalWaitSeconds?(seconds: number): void;
  observeGlobalWaitSeconds?(seconds: number): void;
  observeQueueDepth?(depth: number): void;
  observeQueueDrainLag?(seconds: number): void;
  observeActiveCapacity?(active: number, capacity: number): void;
  observeRetryAttempts?(
    attempts: number,
    labels?: Record<string, string>,
  ): void;
  observeExecutionCircuitFailure?(errorClass: string): void;
  observeTotalProviderAttempts?(
    attempts: number,
    labels?: Record<string, string>,
  ): void;
  observeBackgroundAdmission?(
    feature: string,
    attempt: LlmExecutionAttempt,
    outcome: 'admitted' | 'capacity_overload',
  ): void;
  observeOverloadRegeneration?(feature: string): void;
}

export interface LlmAdmissionGlobalMetrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
}

export interface LlmAdmissionGlobalPort {
  acquire(
    limit: number,
    logger: { warn(message: string): void },
    options?: {
      metrics?: LlmAdmissionGlobalMetrics;
      signal?: AbortSignal;
      waitBudgetMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      leaseMs?: number;
    },
  ): Promise<() => Promise<void>>;
}

export interface LlmAdmissionCoordinatorConfig {
  enabled: boolean;
  maxConcurrent: number;
  maxQueueDepth: number;
  chatAdmissionWaitMs: number;
  backgroundAdmissionWaitMs: number;
  globalMaxConcurrent: number;
  globalConcurrencyEnabled: boolean;
  globalAcquireMaxRetries?: number;
  globalAcquireRetryDelayMs?: number;
  requestTimeoutMs?: number;
  /** Test seam for deterministic equal-jitter backoff. */
  rng?: () => number;
}

export interface LlmAdmissionLease {
  localWaitMs: number;
  globalWaitMs: number;
  release(): Promise<void>;
}

const DEFAULT_GLOBAL_PROBE_ATTEMPTS = 200;
const DEFAULT_GLOBAL_PROBE_DELAY_MS = 50;
const MAX_GLOBAL_PROBE_DELAY_MS = 1_000;

/**
 * Coordinates one process-local FIFO capacity budget with the optional Redis
 * aggregate budget. A local permit is held only for one bounded global probe;
 * saturation releases it before backoff and re-queue.
 */
export class LlmAdmissionCoordinator {
  private readonly queue: BoundedAdmissionQueue;
  private readonly logger: { warn(message: string): void };
  private readonly probeMetrics?: LlmAdmissionGlobalMetrics;

  constructor(
    private readonly config: LlmAdmissionCoordinatorConfig,
    logger: { warn(message: string): void },
    private readonly metrics?: AdmissionMetrics,
    private readonly globalPort?: LlmAdmissionGlobalPort | null,
  ) {
    this.logger = logger;
    this.probeMetrics = metrics
      ? {
          incrementCounter: (name, labels) => {
            if (name === 'llm_admission_rejected_total') return;
            metrics.incrementCounter(name, labels);
          },
        }
      : undefined;
    this.queue = new BoundedAdmissionQueue(
      config.maxConcurrent,
      config.maxQueueDepth,
    );

    if (config.globalConcurrencyEnabled && !globalPort) {
      throw new Error(
        'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a configured Redis client — refusing to start with the aggregate limit silently bypassed (#867)',
      );
    }
  }

  async acquire(
    feature: string,
    signal?: AbortSignal,
  ): Promise<LlmAdmissionLease> {
    const waitBudgetMs = admissionWaitBudgetMs(this.config, feature);
    const startedAtMs = Date.now();
    const maxProbeAttempts =
      this.config.globalAcquireMaxRetries ?? DEFAULT_GLOBAL_PROBE_ATTEMPTS;
    const retryDelayMs =
      this.config.globalAcquireRetryDelayMs ?? DEFAULT_GLOBAL_PROBE_DELAY_MS;
    let probeAttempts = 0;
    let consecutiveRedisErrors = 0;
    let localWaitMs = 0;
    let globalWaitMs = 0;
    let ticket: AdmissionTicket | undefined;

    while (true) {
      if (signal?.aborted) {
        ticket?.release();
        ticket = undefined;
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError');
      }
      const remainingMs = waitBudgetMs - (Date.now() - startedAtMs);
      if (remainingMs <= 0) {
        ticket?.release();
        ticket = undefined;
        const error = new LlmOverloadError(
          this.config.globalConcurrencyEnabled
            ? 'global_saturated'
            : 'wait_timeout',
        );
        this.recordRejection(error);
        throw error;
      }

      if (!ticket) {
        const localStartedAtMs = Date.now();
        try {
          const admission = this.queue.acquire({
            signal,
            waitBudgetMs: remainingMs,
          });
          this.observeQueueState();
          ticket = await admission;
        } catch (error) {
          this.observeQueueState();
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new DOMException('Aborted', 'AbortError');
          }
          this.recordRejection(error);
          throw error;
        }
        localWaitMs += Date.now() - localStartedAtMs;
        this.observeQueueState();
      }

      if (!this.config.globalConcurrencyEnabled) {
        this.observeAdmissionWait(localWaitMs, 0, startedAtMs);
        return this.createLease(ticket, undefined, localWaitMs, 0);
      }

      const globalStartedAtMs = Date.now();
      const probeDeadline = AbortSignal.timeout(Math.max(1, remainingMs));
      const probeSignal = signal
        ? AbortSignal.any([signal, probeDeadline])
        : probeDeadline;
      try {
        const releaseGlobal = await this.globalPort!.acquire(
          this.config.globalMaxConcurrent,
          this.logger,
          {
            metrics: this.probeMetrics,
            signal: probeSignal,
            waitBudgetMs: remainingMs,
            maxRetries: 1,
            retryDelayMs: 0,
            leaseMs: Math.max(this.config.requestTimeoutMs ?? 0, 60_000),
          },
        );
        consecutiveRedisErrors = 0;
        globalWaitMs += Date.now() - globalStartedAtMs;
        this.observeAdmissionWait(localWaitMs, globalWaitMs, startedAtMs);
        return this.createLease(
          ticket,
          releaseGlobal,
          localWaitMs,
          globalWaitMs,
        );
      } catch (error) {
        globalWaitMs += Date.now() - globalStartedAtMs;
        ticket.release();
        ticket = undefined;
        this.observeQueueState();

        let admissionError = error;
        if (probeDeadline.aborted && !signal?.aborted) {
          admissionError = new LlmOverloadError('global_saturated');
        }

        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError');
        }

        if (!(admissionError instanceof LlmOverloadError)) {
          throw admissionError;
        }

        if (admissionError.reason === 'redis_unavailable') {
          consecutiveRedisErrors += 1;
        } else if (admissionError.reason === 'global_saturated') {
          consecutiveRedisErrors = 0;
        } else {
          throw admissionError;
        }

        probeAttempts += 1;
        const afterProbeRemainingMs = waitBudgetMs - (Date.now() - startedAtMs);
        if (
          consecutiveRedisErrors >= DEFAULT_MAX_CONSECUTIVE_REDIS_ERRORS ||
          probeAttempts >= maxProbeAttempts ||
          afterProbeRemainingMs <= 0
        ) {
          this.recordRejection(admissionError);
          throw admissionError;
        }

        const nominalDelayMs = Math.min(
          MAX_GLOBAL_PROBE_DELAY_MS,
          retryDelayMs * 2 ** (probeAttempts - 1),
        );
        const requeueStartedAtMs = Date.now();
        try {
          ticket = await this.queue.acquire({
            signal,
            waitBudgetMs: afterProbeRemainingMs,
            delayMs: Math.min(
              jitteredDelayMs(nominalDelayMs, this.config.rng),
              afterProbeRemainingMs,
            ),
          });
        } catch (requeueError) {
          this.observeQueueState();
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new DOMException('Aborted', 'AbortError');
          }
          this.recordRejection(requeueError);
          throw requeueError;
        } finally {
          globalWaitMs += Date.now() - requeueStartedAtMs;
        }
        this.observeQueueState();
      }
    }
  }

  private createLease(
    ticket: AdmissionTicket,
    releaseGlobal: (() => Promise<void>) | undefined,
    localWaitMs: number,
    globalWaitMs: number,
  ): LlmAdmissionLease {
    let released = false;
    return {
      localWaitMs,
      globalWaitMs,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await releaseGlobal?.();
        } finally {
          ticket.release();
          this.observeQueueState();
        }
      },
    };
  }

  private observeAdmissionWait(
    localWaitMs: number,
    globalWaitMs: number,
    startedAtMs: number,
  ): void {
    this.metrics?.observeWaitSeconds((Date.now() - startedAtMs) / 1000);
    this.metrics?.observeLocalWaitSeconds?.(localWaitMs / 1000);
    this.metrics?.observeGlobalWaitSeconds?.(globalWaitMs / 1000);
  }

  private observeQueueState(): void {
    this.metrics?.observeQueueDepth?.(this.queue.waitingCount);
    this.metrics?.observeQueueDrainLag?.(this.queue.oldestWaitingAgeMs / 1000);
    this.metrics?.observeActiveCapacity?.(
      this.queue.activeCount,
      this.config.maxConcurrent,
    );
  }

  private recordRejection(error: unknown): void {
    if (error instanceof LlmOverloadError) {
      this.metrics?.incrementCounter('llm_admission_rejected_total', {
        reason: error.reason,
      });
    }
  }
}
