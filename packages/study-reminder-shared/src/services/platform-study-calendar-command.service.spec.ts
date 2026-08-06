import { BadRequestException } from '@nestjs/common';
import type {
  WispaceCalendarService,
  WispaceConfigService,
} from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from './platform-study-calendar-command.service';

describe('PlatformStudyCalendarCommandService', () => {
  const timezone = 'Asia/Ho_Chi_Minh';

  function buildCalendarService(
    overrides: Partial<WispaceCalendarService> = {},
  ) {
    return {
      listCalendars: jest.fn(),
      getCalendarSessions: jest.fn(),
      findCalendarRecord: jest.fn(),
      deleteCalendar: jest.fn(),
      createCalendar: jest.fn(),
      ...overrides,
    } as unknown as WispaceCalendarService;
  }

  function buildConfigService(overrides: Partial<WispaceConfigService> = {}) {
    return {
      getTimezone: jest.fn(() => timezone),
      getMinLeadMinutes: jest.fn(() => 120),
      ...overrides,
    } as unknown as WispaceConfigService;
  }

  it('listEntries maps sessions to calendar entries sorted by time', async () => {
    const calendarService = buildCalendarService({
      listCalendars: jest
        .fn()
        .mockResolvedValue([
          { id: 11, eventDate: '2026-08-10', time: '09:00' },
        ]),
      getCalendarSessions: jest.fn().mockResolvedValue([
        {
          sessionKey: 'calendar:11',
          scheduledAt: new Date('2026-08-10T02:00:00Z'),
          topic: 'Writing Task 1',
        },
        {
          sessionKey: 'other:9',
          scheduledAt: new Date('2026-08-09T02:00:00Z'),
          topic: 'skip me',
        },
      ]),
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'discord' },
      calendarService,
      buildConfigService(),
    );

    const { entries } = await service.listEntries('u1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      calendarId: 11,
      eventDate: '2026-08-10',
      time: '09:00',
      topic: 'Writing Task 1',
    });
    expect(entries[0].scheduledTimeLabel).toBeTruthy();
  });

  it('rescheduleSession deletes then recreates the calendar', async () => {
    const findCalendarRecord = jest.fn().mockResolvedValue({
      id: 7,
      eventDate: '2026-08-10',
      time: '09:00',
    });
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn().mockResolvedValue({ id: 8 });
    const calendarService = buildCalendarService({
      findCalendarRecord,
      deleteCalendar,
      createCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    const result = await service.rescheduleSession({
      externalUserId: 'u1',
      userId: 3,
      calendarId: 7,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(deleteCalendar).toHaveBeenCalledWith('u1', 7);
    expect(createCalendar).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ eventDate: '2026-08-11', time: '09:00' }),
      { userId: 3 },
    );
    expect(result.cancelledCalendarId).toBe(7);
    expect(result.created).toEqual({ id: 8 });
  });

  it('enforceLeadTime rejects slots too close to now', async () => {
    const findCalendarRecord = jest.fn().mockResolvedValue({
      id: 7,
      eventDate: '2026-08-10',
      time: '09:00',
    });
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn().mockResolvedValue({ id: 8 });
    const calendarService = buildCalendarService({
      findCalendarRecord,
      deleteCalendar,
      createCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'discord', enforceLeadTime: true },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'explicit',
        newLocalDate: '2020-01-01',
        newTime: '09:00',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleteCalendar).not.toHaveBeenCalled();
  });
});
