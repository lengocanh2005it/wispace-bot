import { errorMessage } from '@wispace/bot-common';
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
    this.listBreaker = createCircuitBreaker(
      (idHeader: WispaceIdHeader, externalId: string) =>
        withRetry(() => this.doListCalendars(idHeader, externalId), {
          maxRetries: this.config.maxRetries ?? 3,
          baseDelayMs: this.config.baseDelayMs ?? 500,
          shouldRetry: isWispaceRetryable,
          onRetry: (attempt, max, err) =>
            this.logger.warn(
              `UserCalendar retry ${attempt}/${max} (${idHeader}=${externalId}): ${errorMessage(err)}`,
            ),
        }),
      { timeout: this.config.requestTimeoutMs ?? 10_000 },
    );
  }

  async listCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<UserCalendarRecord[]> {
    return this.listBreaker.fire(idHeader, externalId);
  }

  private async doListCalendars(
    idHeader: WispaceIdHeader,
    externalId: string,
  ): Promise<UserCalendarRecord[]> {
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
        `UserCalendar API failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }

    const payload: unknown = await response.json();
    const records = normalizeUserCalendarRecords(payload);

    this.logger.log(
      `UserCalendar API returned ${records.length} record(s) (${idHeader}=${externalId})`,
    );

    return records;
  }

  async createCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    input: CreateUserCalendarInput,
    options?: { userId?: number },
  ): Promise<UserCalendarRecord> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
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
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
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
      `UserCalendar API created id=${created.id} (${idHeader}=${externalId})`,
    );

    return created;
  }

  async deleteCalendar(
    idHeader: WispaceIdHeader,
    externalId: string,
    calendarId: number,
  ): Promise<void> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const response = await fetch(`${this.config.url}/${calendarId}`, {
      method: 'DELETE',
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
        `UserCalendar API delete failed: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        externalId,
        'UserCalendar',
      );
    }
  }
}
