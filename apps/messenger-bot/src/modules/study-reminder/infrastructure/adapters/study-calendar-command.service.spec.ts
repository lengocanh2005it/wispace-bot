import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';
import type {
  RescheduleStudySessionResult,
  StudyCalendarEntryView,
} from '@wispace/reschedule-confirm';
import type { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import type { StudySessionSourceService } from '../../application/services/study-session-source.service';
import { StudyCalendarCommandService } from './study-calendar-command.service';

describe('StudyCalendarCommandService', () => {
  let service: StudyCalendarCommandService;
  let calendarCommand: jest.Mocked<
    Pick<
      PlatformStudyCalendarCommandService,
      'listEntries' | 'rescheduleSession'
    >
  >;
  let studyReminderSyncService: jest.Mocked<
    Pick<StudyReminderSyncService, 'syncUpcomingSessions'>
  >;
  let sessionSourceService: jest.Mocked<
    Pick<StudySessionSourceService, 'getUpcomingSessions'>
  >;

  const entries: StudyCalendarEntryView[] = [];
  const rescheduleResult: RescheduleStudySessionResult = {
    cancelledCalendarId: 42,
    created: {
      id: 100,
      userId: 7,
      eventDate: '2026-07-16',
      time: '10:00',
    },
    schedulingMode: 'default_next_day_same_time',
    scheduledTimeLabel: '10:00 thứ Năm',
  };

  beforeEach(() => {
    calendarCommand = {
      listEntries: jest.fn().mockResolvedValue({
        timeRange: 'upcoming',
        entries,
      }),
      rescheduleSession: jest.fn().mockResolvedValue(rescheduleResult),
    };
    studyReminderSyncService = {
      syncUpcomingSessions: jest.fn().mockResolvedValue({
        scope: 'user',
        upserted: 1,
        cancelled: 0,
      }),
    };
    sessionSourceService = {
      getUpcomingSessions: jest.fn(),
    };
    service = new StudyCalendarCommandService(
      calendarCommand as unknown as PlatformStudyCalendarCommandService,
      studyReminderSyncService as unknown as StudyReminderSyncService,
      sessionSourceService as unknown as StudySessionSourceService,
    );
  });

  it('delegates Messenger options and user scope to the shared command', async () => {
    const result = await service.listEntries('psid-1', 7, {
      timeRange: 'past',
      limit: 4,
      pastDays: 30,
    });

    expect(calendarCommand.listEntries).toHaveBeenCalledWith('psid-1', {
      timeRange: 'past',
      limit: 4,
      pastDays: 30,
      userId: 7,
    });
    expect(result).toEqual({ timeRange: 'upcoming', entries });
  });

  it('returns an empty result for an unscoped non-abort calendar read failure', async () => {
    calendarCommand.listEntries.mockRejectedValue(new Error('unknown psid'));

    await expect(service.listEntries('psid-1')).resolves.toEqual({
      timeRange: 'upcoming',
      entries: [],
    });
  });

  it('propagates a linked calendar read failure', async () => {
    const error = new Error('WISPACE unavailable');
    calendarCommand.listEntries.mockRejectedValue(error);

    await expect(service.listEntries('psid-1', 7)).rejects.toBe(error);
  });

  it('propagates abort errors for an unscoped calendar read', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = controller.signal.reason;
    calendarCommand.listEntries.mockRejectedValue(error);

    await expect(service.listEntries('psid-1')).rejects.toBe(error);
  });

  it('delegates rescheduling and queues the Messenger reminder sync', async () => {
    const result = await service.rescheduleSession({
      psid: 'psid-1',
      userId: 7,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
    });

    expect(calendarCommand.rescheduleSession).toHaveBeenCalledWith({
      externalUserId: 'psid-1',
      userId: 7,
      calendarId: 42,
      schedulingMode: 'default_next_day_same_time',
      newLocalDate: undefined,
      newTime: undefined,
    });
    expect(result).toEqual({ ...rescheduleResult, outboxSyncQueued: true });
    expect(studyReminderSyncService.syncUpcomingSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        getSessions: expect.any(Function),
      }),
    );
  });

  it('does not queue a reminder sync when the calendar mutation fails', async () => {
    const error = new Error('calendar write failed');
    calendarCommand.rescheduleSession.mockRejectedValue(error);

    await expect(
      service.rescheduleSession({
        psid: 'psid-1',
        userId: 7,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).rejects.toBe(error);
    expect(
      studyReminderSyncService.syncUpcomingSessions,
    ).not.toHaveBeenCalled();
  });

  it('keeps the committed reschedule result when background sync fails', async () => {
    studyReminderSyncService.syncUpcomingSessions.mockRejectedValue(
      new Error('sync unavailable'),
    );

    await expect(
      service.rescheduleSession({
        psid: 'psid-1',
        userId: 7,
        calendarId: 42,
        schedulingMode: 'default_next_day_same_time',
      }),
    ).resolves.toMatchObject({
      scheduledTimeLabel: rescheduleResult.scheduledTimeLabel,
      outboxSyncQueued: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
