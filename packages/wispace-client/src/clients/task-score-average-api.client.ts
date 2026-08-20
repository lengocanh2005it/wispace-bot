import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { WispaceApiError } from '../errors/wispace-api.error';
import {
  isWispaceRetryable,
  createCircuitBreaker,
  computeCircuitBreakerTimeout,
  withRetry,
} from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import type { TaskScoreAverageRecord } from '../types/task-score-average.types';
import {
  NOOP_WISPACE_LOGGER,
  type WispaceApiClientConfig,
  type WispaceClientLogger,
} from './wispace-client-types';

export class TaskScoreAverageApiClient {
  private readonly breaker: CircuitBreaker<any[], TaskScoreAverageRecord[]>;

  constructor(
    private readonly config: WispaceApiClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    const maxRetries = this.config.maxRetries ?? 3;
    const reqTimeout = this.config.requestTimeoutMs ?? 10_000;
    const circuitTimeout = computeCircuitBreakerTimeout(reqTimeout, maxRetries);

    this.breaker = createCircuitBreaker(
      (
        idHeader: WispaceIdHeader,
        externalId: string,
        options?: { signal?: AbortSignal },
      ) =>
        withRetry(
          () =>
            this.fetchTaskScoreAverages(idHeader, externalId, options?.signal),
          {
            maxRetries,
            baseDelayMs: this.config.baseDelayMs ?? 500,
            shouldRetry: isWispaceRetryable,
            signal: options?.signal,
            onRetry: (attempt, max, err) =>
              this.logger.warn(
                `TaskScoreAverage retry ${attempt}/${max} (${idHeader}=${maskExternalId(
                  externalId,
                )}): ${errorMessage(err)}`,
              ),
          },
        ),
      { timeout: circuitTimeout },
    );
  }

  async getTaskScoreAverages(
    idHeader: WispaceIdHeader,
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskScoreAverageRecord[]> {
    return this.breaker.fire(idHeader, externalId, options);
  }

  private async fetchTaskScoreAverages(
    idHeader: WispaceIdHeader,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<TaskScoreAverageRecord[]> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(signal, timeoutMs);

    const response = await fetch(this.config.url, {
      headers: buildWispaceHeaders(
        idHeader,
        externalId,
        this.config.internalKey,
      ),
      signal: fetchSignal,
    });

    if (!response.ok) {
      throw new WispaceApiError(
        `TaskScoreAverage API failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId,
        'TaskScoreAverage',
      );
    }

    const data = (await response.json()) as TaskScoreAverageRecord[];
    this.logger.log(
      `TaskScoreAverage API returned ${data.length} record(s) (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );
    return data;
  }
}
