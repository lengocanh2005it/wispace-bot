/* eslint-disable @typescript-eslint/no-unsafe-assignment -- mocked fetch init */
import { closeKeepAliveAgents } from '../utils/keep-alive-agent';
import { WispaceConfigService } from '../config/wispace-config.service';
import { WispaceCalendarService } from './wispace-calendar.service';

function buildService(): WispaceCalendarService {
  const values: Record<string, string> = {
    WISPACE_API_USER_CALENDAR_URL:
      'https://backend.example.com/api/UserCalendar',
    WISPACE_INTERNAL_KEY: 'internal-key',
    WISPACE_API_MAX_RETRIES: '0',
    STUDY_REMINDER_TIMEZONE: 'UTC',
  };

  return new WispaceCalendarService(
    'x-discordid',
    new WispaceConfigService((key) => values[key]),
    () => 24,
  );
}

function mockCalendarFetch(
  records: unknown[],
  onRequest?: (init?: RequestInit) => void,
) {
  const fetchMock = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    onRequest?.(init);
    return Promise.resolve(
      new Response(JSON.stringify(records), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

function mockAbortableCalendarFetch() {
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const fetchMock = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    fetchStarted();

    return new Promise((_resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('fetch did not receive caller abort')),
        100,
      );
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timeout);
          reject(init.signal?.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  });
  global.fetch = fetchMock as typeof fetch;
  return { fetchMock, started };
}

function buildUpcomingRecord(id = 1) {
  const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return {
    id,
    eventDate: scheduledAt.toISOString().slice(0, 10),
    time: scheduledAt.toISOString().slice(11, 16),
    userId: 10,
  };
}

describe('WispaceCalendarService', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
    await closeKeepAliveAgents();
  });

  it('propagates caller cancellation to an in-flight calendar fetch', async () => {
    const controller = new AbortController();
    const { fetchMock, started } = mockAbortableCalendarFetch();

    const operation = buildService().getCalendarSessions('discord-user-1', {
      signal: controller.signal,
    });

    await started;
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('propagates caller cancellation through calendar record lookup', async () => {
    const controller = new AbortController();
    const { fetchMock, started } = mockAbortableCalendarFetch();

    const operation = buildService().findCalendarRecord('discord-user-1', 1, {
      signal: controller.signal,
    });

    await started;
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    ['without', false],
    ['with', true],
  ] as const)(
    'keeps schedule reads working %s a caller signal',
    async (_mode, withSignal) => {
      const controller = new AbortController();
      let requestInit: RequestInit | undefined;
      const fetchMock = mockCalendarFetch(
        [buildUpcomingRecord()],
        (init) => (requestInit = init),
      );
      const options = withSignal ? { signal: controller.signal } : undefined;

      const sessions = await buildService().getCalendarSessions(
        'discord-user-1',
        options,
      );

      expect(sessions).toMatchObject([{ sessionKey: 'calendar:1' }]);
      expect(requestInit?.headers).toMatchObject({
        'x-discordid': 'discord-user-1',
        'X-Internal-Key': 'internal-key',
      });
      expect(requestInit?.signal).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['without', false],
    ['with', true],
  ] as const)(
    'keeps direct listCalendars working %s a caller signal',
    async (_mode, withSignal) => {
      const controller = new AbortController();
      const record = buildUpcomingRecord();
      let requestInit: RequestInit | undefined;
      const fetchMock = mockCalendarFetch([record], (init) => {
        requestInit = init;
      });
      const options = withSignal ? { signal: controller.signal } : undefined;

      await expect(
        buildService().listCalendars('discord-user-1', options),
      ).resolves.toEqual([record]);
      expect(requestInit?.headers).toMatchObject({
        'x-discordid': 'discord-user-1',
        'X-Internal-Key': 'internal-key',
      });
      expect(requestInit?.signal).toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});
