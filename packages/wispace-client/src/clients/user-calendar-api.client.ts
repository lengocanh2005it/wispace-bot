import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
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
import { formatEventDateForApiWrite } from '../utils/study-calendar.utils';
import { fetchWispaceJson, ARRAY_MAX_BYTES } from '../utils/fetch-wispace-json';
import { keepAliveFetch } from '../utils/keep-alive-agent';
import { ShapeValidationError } from '../utils/validate-shape';
import type {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from '../types/user-calendar.types';
import {
  normalizeCreatedCalendarRecord,
  normalizeUserCalendarRecords,
} from './user-calendar-record.normalizer';
import {
  NOOP_WISPACE_LOGGER,
  type WispaceApiClientConfig,
  type WispaceClientLogger,
} from './wispace-client-types';

export class UserCalendarApiClient {
  // One breaker for all three operations (#656): same upstream host, same
  // sickness — a failing write path must stop hammering just like a failing
  // read path. The op closure carries per-operation retry logging.
  private readonly breaker: CircuitBreaker<
    [run: () => Promise<unknown>],
    unknown
  >;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly config: WispaceApiClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    const maxRetries = this.config.maxRetries ?? 3;
    this.maxRetries = maxRetries;
    this.baseDelayMs = this.config.baseDelayMs ?? 500;
    const reqTimeout = this.config.requestTimeoutMs ?? 10_000;
    const circuitTimeout = computeCircuitBreakerTimeout(reqTimeout, maxRetries);

    this.breaker = createCircuitBreaker(
      (run: () => Promise<unknown>) => run(),
      { timeout: circuitTimeout },
    );
  }

  async listCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]> {
    const call = () =>
      this.guarded(
        () => this.doListCalendars(idHeader, externalId, options?.signal),
        idHeader,
        externalId,
        options?.signal,
      );
    return (
      this.config.metrics?.timeWispaceCall('UserCalendar', 'list', call) ??
      call()
    );
  }

  async createCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord> {
    // Safe to retry: the reschedule flow reuses an existing target slot on
    // repeated create (create-before-delete idempotency).
    const call = () =>
      this.guarded(
        () => this.doCreateCalendar(idHeader, externalId, input, options),
        idHeader,
        externalId,
        options?.signal,
      );
    return (
      this.config.metrics?.timeWispaceCall('UserCalendar', 'create', call) ??
      call()
    );
  }

  async deleteCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const call = () =>
      this.guarded(
        () => this.doDeleteCalendar(idHeader, externalId, calendarId, options),
        idHeader,
        externalId,
        options?.signal,
      );
    return (
      this.config.metrics?.timeWispaceCall('UserCalendar', 'delete', call) ??
      call()
    );
  }

  private guarded<T>(
    op: () => Promise<T>,
    idHeader: WispaceIdHeader,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.breaker.fire(() =>
      withRetry(op, {
        maxRetries: this.maxRetries,
        baseDelayMs: this.baseDelayMs,
        shouldRetry: isWispaceRetryable,
        signal,
        onRetry: (attempt, max, err) =>
          this.logger.warn(
            `UserCalendar retry ${attempt}/${max} (${idHeader}=${maskExternalId(
              externalId,
            )}): ${errorMessage(err)}`,
          ),
      }),
    ) as Promise<T>;
  }

  private async doListCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<UserCalendarRecord[]> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(signal, timeoutMs);

    const response = await keepAliveFetch(
      this.config.url,
      {
        headers: buildWispaceHeaders(
          idHeader,
          externalId,
          this.config.internalKey,
        ),
        signal: fetchSignal,
      },
      { poolSize: this.config.poolSize, logger: this.logger },
    );

    if (!response.ok) {
      throw new WispaceApiError(
        `UserCalendar API failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }

    const payload: unknown = await fetchWispaceJson(response, {
      maxBytes: ARRAY_MAX_BYTES,
    });
    const records = normalizeUserCalendarRecords(payload);

    this.logger.log(
      `UserCalendar API returned ${records.length} record(s) (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );

    return records;
  }

  private async doCreateCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(options?.signal, timeoutMs);

    const response = await keepAliveFetch(
      this.config.url,
      {
        method: 'POST',
        headers: {
          ...buildWispaceHeaders(idHeader, externalId, this.config.internalKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          eventDate: formatEventDateForApiWrite(input.eventDate),
          time: input.time,
        }),
        signal: fetchSignal,
      },
      { poolSize: this.config.poolSize, logger: this.logger },
    );

    if (!response.ok) {
      throw new WispaceApiError(
        `UserCalendar API create failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }

    const payload: unknown = await fetchWispaceJson(response);
    const created = normalizeCreatedCalendarRecord(payload, {
      eventDate: input.eventDate,
      time: input.time,
      userId: options?.userId,
    });
    if (!created) {
      throw new ShapeValidationError(
        'Missing required field "id"',
        'id',
        'positive number',
        payload,
      );
    }

    this.logger.log(
      `UserCalendar API created id=${created.id} (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );

    return created;
  }

  private async doDeleteCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(options?.signal, timeoutMs);

    const response = await keepAliveFetch(
      `${this.config.url}/${calendarId}`,
      {
        method: 'DELETE',
        headers: buildWispaceHeaders(
          idHeader,
          externalId,
          this.config.internalKey,
        ),
        signal: fetchSignal,
      },
      { poolSize: this.config.poolSize, logger: this.logger },
    );

    if (!response.ok) {
      throw new WispaceApiError(
        `UserCalendar API delete failed: HTTP ${response.status} ${response.statusText}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }
  }
}
