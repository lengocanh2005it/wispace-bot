import { WispaceApiError } from '../errors/wispace-api.error';
import {
  isWispaceRetryable,
  createCircuitBreaker,
  withRetry,
} from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
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
    this.breaker = createCircuitBreaker(
      (idHeader: WispaceIdHeader, externalId: string) =>
        withRetry(() => this.fetchTaskScoreAverages(idHeader, externalId), {
          maxRetries: this.config.maxRetries ?? 3,
          baseDelayMs: this.config.baseDelayMs ?? 500,
          shouldRetry: isWispaceRetryable,
          onRetry: (attempt, max, err) =>
            this.logger.warn(
              `TaskScoreAverage retry ${attempt}/${max} (${idHeader}=${externalId}): ${err instanceof Error ? err.message : String(err)}`,
            ),
        }),
      { timeout: this.config.requestTimeoutMs ?? 10_000 },
    );
  }

  async getTaskScoreAverages(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<TaskScoreAverageRecord[]> {
    return this.breaker.fire(idHeader, externalId);
  }

  private async fetchTaskScoreAverages(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<TaskScoreAverageRecord[]> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const response = await fetch(this.config.url, {
      headers: buildWispaceHeaders(
        idHeader,
        externalId,
        this.config.internalKey,
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new WispaceApiError(
        `TaskScoreAverage API failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'TaskScoreAverage',
      );
    }

    const data = (await response.json()) as TaskScoreAverageRecord[];
    this.logger.log(
      `TaskScoreAverage API returned ${data.length} record(s) (${idHeader}=${externalId})`,
    );
    return data;
  }
}
