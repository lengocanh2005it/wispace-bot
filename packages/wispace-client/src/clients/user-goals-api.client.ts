import { errorMessage } from '@wispace/bot-common';
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
  private readonly breaker: CircuitBreaker<any[], UserGoalsRecord>;

  constructor(
    private readonly config: WispaceApiClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    const maxRetries = this.config.maxRetries ?? 3;
    const reqTimeout = this.config.requestTimeoutMs ?? 10_000;
    const circuitTimeout = reqTimeout * (maxRetries + 1) + 10_000;

    this.breaker = createCircuitBreaker(
      (
        idHeader: WispaceIdHeader,
        externalId: string,
        options?: { signal?: AbortSignal },
      ) =>
        withRetry(
          () => this.fetchUserGoals(idHeader, externalId, options?.signal),
          {
            maxRetries,
            baseDelayMs: this.config.baseDelayMs ?? 500,
            shouldRetry: isWispaceRetryable,
            signal: options?.signal,
            onRetry: (attempt, max, err) =>
              this.logger.warn(
                `User/goals retry ${attempt}/${max} (${idHeader}=${externalId}): ${errorMessage(err)}`,
              ),
          },
        ),
      { timeout: circuitTimeout },
    );
  }

  async getUserGoals(
    idHeader: WispaceIdHeader,
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserGoalsRecord> {
    return this.breaker.fire(idHeader, externalId, options);
  }

  private async fetchUserGoals(
    idHeader: WispaceIdHeader,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<UserGoalsRecord> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const fetchSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(this.config.url, {
      headers: buildWispaceHeaders(
        idHeader,
        externalId,
        this.config.internalKey,
      ),
      signal: fetchSignal,
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
