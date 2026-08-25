import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { WispaceApiError } from '../errors/wispace-api.error';
import {
  isWispaceRetryable,
  createCircuitBreaker,
  computeCircuitBreakerTimeout,
} from '../utils/with-retry';
import type { CircuitBreaker } from '../utils/with-retry';
import { withRetry } from '../utils/with-retry';
import { mergeWithTimeout } from '../utils/abort-signal.utils';
import {
  buildWispaceHeaders,
  type WispaceIdHeader,
} from '../utils/wispace-headers';
import {
  validateShape,
  isNonEmptyString,
  isDateString,
} from '../utils/validate-shape';
import { fetchWispaceJson } from '../utils/fetch-wispace-json';
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
    const circuitTimeout = computeCircuitBreakerTimeout(reqTimeout, maxRetries);

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
                `User/goals retry ${attempt}/${max} (${idHeader}=${maskExternalId(
                  externalId,
                )}): ${errorMessage(err)}`,
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
        `User goals API failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId,
        'User/goals',
      );
    }

    const rawData = await fetchWispaceJson(response);

    const data = validateShape<{ targetScore: string; examDate: string }>(
      rawData,
      [
        {
          name: 'targetScore',
          validate: isNonEmptyString,
          expected: 'non-empty string',
        },
        {
          name: 'examDate',
          validate: isDateString,
          expected: 'ISO date string',
        },
      ],
    );

    const targetScore = Number(data.targetScore);
    this.logger.log(
      `User goals API returned targetScore=${targetScore}, examDate=${data.examDate} (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );
    return { targetScore, examDate: data.examDate };
  }
}
