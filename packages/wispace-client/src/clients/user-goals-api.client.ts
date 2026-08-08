import { WispaceApiError } from '../errors/wispace-api.error';
import { isWispaceRetryable, createCircuitBreaker } from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
import { withRetry } from '../utils/with-retry';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import type { UserGoalsRecord } from '../types/user-goals.types';
import {
  NOOP_WISPACE_LOGGER,
  type WispaceApiClientConfig,
  type WispaceClientLogger,
} from './wispace-client-types';

export class UserGoalsApiClient {
  private readonly breaker: CircuitBreaker<UserGoalsRecord>;

  constructor(
    private readonly config: WispaceApiClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    this.breaker = createCircuitBreaker(
      (idHeader: WispaceIdHeader, externalId: string) =>
        withRetry(() => this.fetchUserGoals(idHeader, externalId), {
          maxRetries: this.config.maxRetries ?? 3,
          baseDelayMs: this.config.baseDelayMs ?? 500,
          shouldRetry: isWispaceRetryable,
          onRetry: (attempt, max, err) =>
            this.logger.warn(
              `User/goals retry ${attempt}/${max} (${idHeader}=${externalId}): ${err instanceof Error ? err.message : String(err)}`,
            ),
        }),
      { timeout: this.config.requestTimeoutMs ?? 10_000 },
    );
  }

  async getUserGoals(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<UserGoalsRecord> {
    return this.breaker.fire(idHeader, externalId);
  }

  private async fetchUserGoals(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<UserGoalsRecord> {
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
        `User goals API failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'User/goals',
      );
    }

    const data = (await response.json()) as UserGoalsRecord;
    this.logger.log(
      `User goals API returned targetScore=${data.targetScore}, examDate=${data.examDate} (${idHeader}=${externalId})`,
    );
    return data;
  }
}
