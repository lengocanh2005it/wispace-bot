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
import {
  validateShape,
  isPositiveNumber,
  isNonEmptyString,
} from '../utils/validate-shape';
import { fetchWispaceJson, ARRAY_MAX_BYTES } from '../utils/fetch-wispace-json';
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

    const rawData = await fetchWispaceJson(response, {
      maxBytes: ARRAY_MAX_BYTES,
    });

    if (!Array.isArray(rawData)) {
      throw new WispaceApiError(
        `TaskScoreAverage API returned non-array: ${typeof rawData}`,
        502,
        externalId,
        'TaskScoreAverage',
      );
    }

    const data: TaskScoreAverageRecord[] = [];
    for (const [index, item] of rawData.entries()) {
      try {
        data.push(
          validateShape<TaskScoreAverageRecord>(item, [
            {
              name: 'id',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'userId',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'task',
              validate: isNonEmptyString,
              expected: 'non-empty string',
            },
            {
              name: 'avgTaskAchievement',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'avgCoherenceCohesion',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'avgLexicalResource',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'avgGrammaticalRangeAccuracy',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'avgTotalScore',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'task1Count',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'task2Count',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'totalTasks',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'currentStreak',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'highestStreak',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
            {
              name: 'totalPracticeTimeMinutes',
              validate: isPositiveNumber,
              expected: 'positive number',
            },
          ]),
        );
      } catch (error) {
        throw new WispaceApiError(
          `TaskScoreAverage API returned invalid shape at index ${index}: ${error instanceof Error ? error.message : 'unknown error'}`,
          502,
          externalId,
          'TaskScoreAverage',
        );
      }
    }

    this.logger.log(
      `TaskScoreAverage API returned ${data.length} record(s) (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );
    return data;
  }
}
