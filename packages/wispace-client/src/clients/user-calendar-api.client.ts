import {
  errorMessage,
  maskExternalId,
  readResponseText,
} from '@wispace/bot-common';
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
  private readonly listBreaker: CircuitBreaker<any[], UserCalendarRecord[]>;

  constructor(
    private readonly config: WispaceApiClientConfig,
    private readonly logger: WispaceClientLogger = NOOP_WISPACE_LOGGER,
  ) {
    const maxRetries = this.config.maxRetries ?? 3;
    const reqTimeout = this.config.requestTimeoutMs ?? 10_000;
    const circuitTimeout = computeCircuitBreakerTimeout(reqTimeout, maxRetries);

    this.listBreaker = createCircuitBreaker(
      (
        idHeader: WispaceIdHeader,
        externalId: string,
        options?: { signal?: AbortSignal },
      ) =>
        withRetry(
          () => this.doListCalendars(idHeader, externalId, options?.signal),
          {
            maxRetries,
            baseDelayMs: this.config.baseDelayMs ?? 500,
            shouldRetry: isWispaceRetryable,
            signal: options?.signal,
            onRetry: (attempt, max, err) =>
              this.logger.warn(
                `UserCalendar retry ${attempt}/${max} (${idHeader}=${maskExternalId(
                  externalId,
                )}): ${errorMessage(err)}`,
              ),
          },
        ),
      { timeout: circuitTimeout },
    );
  }

  async listCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserCalendarRecord[]> {
    return this.listBreaker.fire(idHeader, externalId, options);
  }

  private async doListCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<UserCalendarRecord[]> {
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
      const body = await readResponseText(response);
      throw new WispaceApiError(
        `UserCalendar API failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }

    const payload: unknown = await response.json();
    const records = normalizeUserCalendarRecords(payload);

    this.logger.log(
      `UserCalendar API returned ${records.length} record(s) (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );

    return records;
  }

  async createCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number; signal?: AbortSignal },
  ): Promise<UserCalendarRecord> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(options?.signal, timeoutMs);

    const response = await fetch(this.config.url, {
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
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      throw new WispaceApiError(
        `UserCalendar API create failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }

    const payload: unknown = await response.json();
    const created = normalizeCreatedCalendarRecord(payload, {
      eventDate: input.eventDate,
      time: input.time,
      userId: options?.userId,
    });
    if (!created) {
      throw new Error(
        `UserCalendar API create returned invalid record: ${JSON.stringify(payload)}`,
      );
    }

    this.logger.log(
      `UserCalendar API created id=${created.id} (${idHeader}=${maskExternalId(
        externalId,
      )})`,
    );

    return created;
  }

  async deleteCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    calendarId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const fetchSignal = mergeWithTimeout(options?.signal, timeoutMs);

    const response = await fetch(`${this.config.url}/${calendarId}`, {
      method: 'DELETE',
      headers: buildWispaceHeaders(
        idHeader,
        externalId,
        this.config.internalKey,
      ),
      signal: fetchSignal,
    });

    if (!response.ok) {
      const body = await readResponseText(response);
      throw new WispaceApiError(
        `UserCalendar API delete failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }
  }
}
