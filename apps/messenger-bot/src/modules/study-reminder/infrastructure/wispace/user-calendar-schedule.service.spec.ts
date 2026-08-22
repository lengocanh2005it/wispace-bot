import { ConfigService } from '@nestjs/config';
// ponytail: deduped — using shared WispaceApiError from @wispace/wispace-client
import { WispaceApiError } from '@wispace/wispace-client';
import { UserCalendarApiService } from './user-calendar-api.service';
import { UserCalendarScheduleService } from './user-calendar-schedule.service';

describe('UserCalendarScheduleService', () => {
  const horizonEnd = new Date('2026-12-31T23:59:59.000Z');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createService(
    listCalendars: UserCalendarApiService['listCalendars'],
  ): UserCalendarScheduleService {
    const api = {
      listCalendars: jest.fn(listCalendars),
    } as unknown as UserCalendarApiService;
    const config = {
      get: (key: string) =>
        key === 'CHAT_USAGE_TIMEZONE' ? 'Asia/Ho_Chi_Minh' : undefined,
    } as ConfigService;

    return new UserCalendarScheduleService(api, config);
  }

  it('loads upcoming sessions from UserCalendar API only', async () => {
    const service = createService(() =>
      Promise.resolve([
        {
          id: 42,
          userId: 143,
          eventDate: '2026-06-20T10:00:00.000Z',
          time: '17:00',
        },
      ]),
    );

    const sessions = await service.getUpcomingSessions(
      'psid-1',
      horizonEnd,
      143,
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionKey).toBe('calendar:42');
  });

  it('rethrows API errors for linked sync users so sync skips cancellation', async () => {
    const service = createService(() => {
      throw new WispaceApiError('down', 503, 'psid-1', 'UserCalendar');
    });

    await expect(
      service.getUpcomingSessions('psid-1', horizonEnd, 143),
    ).rejects.toBeInstanceOf(WispaceApiError);
  });

  it('returns empty list when API fails for an unlinked user', async () => {
    const service = createService(() => {
      throw new WispaceApiError('down', 503, 'psid-1', 'UserCalendar');
    });

    const sessions = await service.getUpcomingSessions(
      'psid-1',
      horizonEnd,
      undefined,
    );

    expect(sessions).toEqual([]);
  });

  it('finds calendar record via API only', async () => {
    const service = createService(() =>
      Promise.resolve([
        {
          id: 7,
          userId: 143,
          eventDate: '2026-06-20T10:00:00.000Z',
          time: '17:00',
        },
      ]),
    );

    await expect(
      service.findCalendarRecord('psid-1', 7),
    ).resolves.toMatchObject({
      id: 7,
    });
    await expect(service.findCalendarRecord('psid-1', 99)).resolves.toBeNull();
  });
});
