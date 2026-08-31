import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  RescheduleConfigPort,
  StudyCalendarPort,
} from '../ports/study-calendar.port';
import { PlatformStudyCalendarCommandService } from './platform-study-calendar-command.service';

describe('PlatformStudyCalendarCommandService', () => {
  const timezone = 'Asia/Ho_Chi_Minh';

  function buildCalendarService(overrides: Partial<StudyCalendarPort> = {}) {
    return {
      listCalendars: jest.fn(),
      getCalendarSessions: jest.fn(),
      findCalendarRecord: jest.fn(),
      deleteCalendar: jest.fn(),
      createCalendar: jest.fn(),
      ...overrides,
    } as unknown as StudyCalendarPort;
  }

  function buildConfigService(overrides: Partial<RescheduleConfigPort> = {}) {
    return {
      getTimezone: jest.fn(() => timezone),
      getMinLeadMinutes: jest.fn(() => 120),
      ...overrides,
    } as unknown as RescheduleConfigPort;
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

  it('rescheduleSession fetches the calendar list exactly once (#455)', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const calendarService = buildCalendarService({
      listCalendars,
      deleteCalendar: jest.fn().mockResolvedValue(undefined),
      createCalendar: jest.fn().mockResolvedValue({ id: 8, userId: 3 }),
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    await service.rescheduleSession({
      externalUserId: 'u1',
      userId: 3,
      calendarId: 7,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(listCalendars).toHaveBeenCalledTimes(1);
    expect(calendarService.findCalendarRecord).not.toHaveBeenCalled();
  });

  it('rescheduleSession rejects when the source is missing from the fetched list', async () => {
    const calendarService = buildCalendarService({
      listCalendars: jest
        .fn()
        .mockResolvedValue([
          { id: 11, eventDate: '2026-08-12', time: '10:00' },
        ]),
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calendarService.createCalendar).not.toHaveBeenCalled();
  });

  it('rescheduleSession creates the replacement first, then deletes the source', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn().mockResolvedValue({ id: 8, userId: 3 });
    const calendarService = buildCalendarService({
      listCalendars,
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

    expect(createCalendar).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ eventDate: '2026-08-11', time: '09:00' }),
      { userId: 3 },
    );
    expect(deleteCalendar).toHaveBeenCalledWith('u1', 7);
    expect(createCalendar.mock.invocationCallOrder[0]).toBeLessThan(
      deleteCalendar.mock.invocationCallOrder[0],
    );
    expect(result.cancelledCalendarId).toBe(7);
    expect(result.created).toEqual({ id: 8, userId: 3 });
  });

  it('reuses an existing replacement on retry (no duplicate creation)', async () => {
    // Crash between create and delete: the replacement already exists in the
    // same snapshot the idempotency check reuses.
    const listCalendars = jest.fn().mockResolvedValue([
      { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      { id: 8, userId: 3, eventDate: '2026-08-11', time: '09:00' },
    ]);
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn();
    const calendarService = buildCalendarService({
      listCalendars,
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

    expect(createCalendar).not.toHaveBeenCalled();
    expect(deleteCalendar).toHaveBeenCalledWith('u1', 7);
    expect(result.created).toMatchObject({ id: 8, userId: 3 });
  });

  it('does not reuse a replacement owned by another WISPACE user', async () => {
    const listCalendars = jest.fn().mockResolvedValue([
      { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      { id: 8, userId: 99, eventDate: '2026-08-11', time: '09:00' },
    ]);
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn().mockResolvedValue({ id: 9, userId: 3 });
    const calendarService = buildCalendarService({
      listCalendars,
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

    expect(createCalendar).toHaveBeenCalledTimes(1);
    expect(result.created).toMatchObject({ id: 9, userId: 3 });
    expect(deleteCalendar).toHaveBeenCalledWith('u1', 7);
  });

  it('rejects a source owned by another WISPACE user before creating or deleting', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 99, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const createCalendar = jest.fn();
    const deleteCalendar = jest.fn();
    const calendarService = buildCalendarService({
      listCalendars,
      createCalendar,
      deleteCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'discord' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toThrow('scope');
    expect(createCalendar).not.toHaveBeenCalled();
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it('does not delete the source when the created record is not owned by the caller', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const createCalendar = jest.fn().mockResolvedValue({ id: 8, userId: 99 });
    const deleteCalendar = jest.fn();
    const calendarService = buildCalendarService({
      listCalendars,
      createCalendar,
      deleteCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'discord' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toThrow('scope');
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it('keeps the original session when creation fails (no delete before create)', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const deleteCalendar = jest.fn();
    const createCalendar = jest
      .fn()
      .mockRejectedValue(new Error('WISPACE timeout'));
    const calendarService = buildCalendarService({
      listCalendars,
      deleteCalendar,
      createCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toThrow('WISPACE timeout');
    expect(deleteCalendar).not.toHaveBeenCalled();
  });

  it('create timeout after a crash retry keeps the original and converges without duplicates', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const deleteCalendar = jest.fn();
    // First attempt times out mid-create (no session lost, nothing deleted).
    const createCalendar = jest
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ id: 8, userId: 3 });
    const calendarService = buildCalendarService({
      listCalendars,
      deleteCalendar,
      createCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toThrow('timed out');
    expect(deleteCalendar).not.toHaveBeenCalled();

    // Retry succeeds: exactly one replacement, source deleted once.
    const result = await service.rescheduleSession({
      externalUserId: 'u1',
      userId: 3,
      calendarId: 7,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(createCalendar).toHaveBeenCalledTimes(2);
    expect(deleteCalendar).toHaveBeenCalledTimes(1);
    expect(result.created).toMatchObject({ id: 8 });
  });

  it('retries the source deletion and throws when it still fails', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const deleteCalendar = jest
      .fn()
      .mockRejectedValue(new Error('delete down'));
    const createCalendar = jest.fn().mockResolvedValue({ id: 8, userId: 3 });
    const calendarService = buildCalendarService({
      listCalendars,
      deleteCalendar,
      createCalendar,
    });
    const service = new PlatformStudyCalendarCommandService(
      { platform: 'zalo' },
      calendarService,
      buildConfigService(),
    );

    await expect(
      service.rescheduleSession({
        externalUserId: 'u1',
        userId: 3,
        calendarId: 7,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toThrow('delete down');
    expect(deleteCalendar).toHaveBeenCalledTimes(3);
    expect(createCalendar).toHaveBeenCalledTimes(1);
  });

  it('enforceLeadTime rejects slots too close to now', async () => {
    const listCalendars = jest
      .fn()
      .mockResolvedValue([
        { id: 7, userId: 3, eventDate: '2026-08-10', time: '09:00' },
      ]);
    const deleteCalendar = jest.fn().mockResolvedValue(undefined);
    const createCalendar = jest.fn().mockResolvedValue({ id: 8, userId: 3 });
    const calendarService = buildCalendarService({
      listCalendars,
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
