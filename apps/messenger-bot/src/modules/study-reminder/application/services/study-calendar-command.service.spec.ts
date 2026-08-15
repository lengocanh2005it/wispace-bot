import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { UserCalendarDataPort } from '../../domain/ports/user-calendar-data.port';
import type { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import type { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import type { NormalizedStudySession } from '../../domain/entities/study-schedule.types';
import type { UserCalendarRecord } from '../../domain/entities/user-calendar.types';
import { StudyCalendarCommandService } from './study-calendar-command.service';

describe('StudyCalendarCommandService', () => {
  let service: StudyCalendarCommandService;
  let calendarData: jest.Mocked<UserCalendarDataPort>;
  let scheduleService: jest.Mocked<StudyReminderScheduleService>;
  let syncService: jest.Mocked<StudyReminderSyncService>;

  const defaultSettings = {
    syncHorizonHours: 168,
    maxRetries: 3,
    timezone: 'Asia/Ho_Chi_Minh',
    minutesBefore: 30,
    minLeadMinutes: 10,
    retryBackoffMinutes: 5,
    jobRetentionDays: 30,
    eveningRolloverHour: 23,
    stuckProcessingMs: 600_000,
  };

  function makeRecord(
    overrides: Partial<UserCalendarRecord> = {},
  ): UserCalendarRecord {
    return {
      id: 42,
      userId: 1,
      eventDate: '2026-07-15T00:00:00Z',
      time: '10:00',
      ...overrides,
    };
  }

  function makeSession(
    overrides: Partial<NormalizedStudySession> = {},
  ): NormalizedStudySession {
    return {
      sessionKey: 'calendar:42',
      scheduledAt: new Date('2026-07-15T10:00:00Z'),
      topic: 'Toán',
      ...overrides,
    };
  }

  beforeEach(() => {
    calendarData = {
      listCalendars: jest.fn().mockResolvedValue([]),
      createCalendar: jest.fn(),
      deleteCalendar: jest.fn().mockResolvedValue(undefined),
      getUpcomingSessions: jest.fn().mockResolvedValue([]),
      getCalendarSessions: jest.fn().mockResolvedValue([]),
      findCalendarRecord: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<UserCalendarDataPort>;

    scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue(defaultSettings),
      formatScheduledTimeLabel: jest.fn().mockReturnValue('10:00 thứ Tư'),
      getMinutesUntilSession: jest.fn().mockReturnValue(60),
    } as unknown as jest.Mocked<StudyReminderScheduleService>;

    syncService = {
      syncUpcomingSessions: jest.fn().mockResolvedValue({
        scope: 'user',
        upserted: 0,
        cancelled: 0,
      }),
    } as unknown as jest.Mocked<StudyReminderSyncService>;

    service = new StudyCalendarCommandService(
      calendarData,
      scheduleService,
      syncService,
    );
  });

  describe('listEntries', () => {
    it('returns empty entries when no sessions exist', async () => {
      const result = await service.listEntries('psid-1');

      expect(result.entries).toEqual([]);
      expect(result.timeRange).toBe('upcoming');
    });

    it('maps sessions to entries with calendar metadata', async () => {
      const record = makeRecord();
      const session = makeSession();

      calendarData.listCalendars.mockResolvedValue([record]);
      calendarData.getCalendarSessions.mockResolvedValue([session]);

      const result = await service.listEntries('psid-1');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        calendarId: 42,
        eventDate: record.eventDate,
        time: record.time,
        topic: 'Toán',
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(scheduleService.formatScheduledTimeLabel).toHaveBeenCalled();
    });

    it('filters out sessions with non-matching sessionKey format', async () => {
      const session = makeSession({ sessionKey: 'invalid-key' });
      calendarData.getCalendarSessions.mockResolvedValue([session]);

      const result = await service.listEntries('psid-1');

      expect(result.entries).toEqual([]);
    });

    it('uses DEFAULT_TOPIC when session topic is empty', async () => {
      const session = makeSession({ topic: '' });
      calendarData.getCalendarSessions.mockResolvedValue([session]);

      const result = await service.listEntries('psid-1');

      expect(result.entries[0]?.topic).toBeDefined();
    });
  });

  describe('rescheduleSession', () => {
    it('throws NotFoundException when calendar record not found', async () => {
      calendarData.findCalendarRecord.mockResolvedValue(null);

      await expect(
        service.rescheduleSession({
          psid: 'psid-1',
          userId: 1,
          calendarId: 999,
          schedulingMode: 'default_next_day_same_time',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when new slot is too close', async () => {
      const record = makeRecord();
      calendarData.findCalendarRecord.mockResolvedValue(record);
      scheduleService.getMinutesUntilSession.mockReturnValue(5); // < minLeadMinutes (10)

      await expect(
        service.rescheduleSession({
          psid: 'psid-1',
          userId: 1,
          calendarId: 42,
          schedulingMode: 'default_next_day_same_time',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates the replacement first, deletes the source, and triggers background sync', async () => {
      const record = makeRecord();
      const created = makeRecord({ id: 100 });
      calendarData.findCalendarRecord.mockResolvedValue(record);
      calendarData.createCalendar.mockResolvedValue(created);
      scheduleService.getMinutesUntilSession.mockReturnValue(120);

      const result = await service.rescheduleSession({
        psid: 'psid-1',
        userId: 1,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(calendarData.createCalendar).toHaveBeenCalledWith(
        'psid-1',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ eventDate: expect.any(String) }),
        { userId: 1 },
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(calendarData.deleteCalendar).toHaveBeenCalledWith('psid-1', 42);
      expect(
        calendarData.createCalendar.mock.invocationCallOrder[0],
      ).toBeLessThan(calendarData.deleteCalendar.mock.invocationCallOrder[0]);
      expect(result).toMatchObject({
        cancelledCalendarId: 42,
        created,
        outboxSyncQueued: true,
      });
      // Background sync is fire-and-forget
    });

    it('keeps the original session when creation fails (no delete before create)', async () => {
      const record = makeRecord();
      calendarData.findCalendarRecord.mockResolvedValue(record);
      calendarData.createCalendar.mockRejectedValue(new Error('API down'));
      scheduleService.getMinutesUntilSession.mockReturnValue(120);

      await expect(
        service.rescheduleSession({
          psid: 'psid-1',
          userId: 1,
          calendarId: 42,
          schedulingMode: 'default_next_day_same_time',
        }),
      ).rejects.toThrow('API down');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(calendarData.deleteCalendar).not.toHaveBeenCalled();
    });

    it('reuses an existing replacement on retry (no duplicate creation)', async () => {
      const record = makeRecord();
      calendarData.findCalendarRecord.mockResolvedValue(record);
      // Crash between create and delete: the replacement already exists.
      const existing = makeRecord({
        id: 100,
        eventDate: '2026-07-16',
        time: '10:00',
      });
      calendarData.listCalendars.mockResolvedValue([existing]);
      scheduleService.getMinutesUntilSession.mockReturnValue(120);

      const result = await service.rescheduleSession({
        psid: 'psid-1',
        userId: 1,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
      });

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(calendarData.createCalendar).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(calendarData.deleteCalendar).toHaveBeenCalledWith('psid-1', 42);
      expect(result.created).toEqual(existing);
    });
  });
});
