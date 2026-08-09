import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { CalendarSessionTimeRange } from '../../domain/entities/study-schedule.types';
import { UserCalendarRecord } from '../../domain/entities/user-calendar.types';
import { UserCalendarApiService } from '../../infrastructure/wispace/user-calendar-api.service';
import { UserCalendarScheduleService } from '../../infrastructure/wispace/user-calendar-schedule.service';
import {
  type RescheduleSchedulingMode,
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
} from '@wispace/wispace-client';
import type {
  RescheduleStudySessionResult,
  StudyCalendarEntryView,
} from '@wispace/reschedule-confirm';
import { StudyReminderScheduleService } from '@wispace/study-reminder-shared';
import { StudyReminderSyncService } from '@wispace/study-reminder-shared';
import { hoursFromNow } from '@wispace/date-utils';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';

@Injectable()
export class StudyCalendarCommandService {
  private readonly logger = new Logger(StudyCalendarCommandService.name);

  constructor(
    private readonly userCalendarApiService: UserCalendarApiService,
    private readonly userCalendarScheduleService: UserCalendarScheduleService,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
  ) {}

  async listEntries(
    psid: string,
    userId?: number,
    options?: {
      timeRange?: CalendarSessionTimeRange;
      limit?: number;
      pastDays?: number;
    },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }> {
    const timeRange = options?.timeRange ?? 'upcoming';
    const records = await this.userCalendarApiService.listCalendars(psid);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const { syncHorizonHours } =
      this.studyReminderScheduleService.getOutboxSettings();
    const horizonEnd = hoursFromNow(syncHorizonHours);
    const sessions = await this.userCalendarScheduleService.getCalendarSessions(
      psid,
      horizonEnd,
      {
        timeRange,
        userId,
        pastDays: options?.pastDays,
        limit: options?.limit,
      },
    );

    const entries = sessions
      .slice()
      .sort(
        (left, right) =>
          left.scheduledAt.getTime() - right.scheduledAt.getTime(),
      )
      .map((session) => {
        const match = /^calendar:(\d+)$/.exec(session.sessionKey);
        if (!match) {
          return null;
        }

        const calendarId = Number(match[1]);
        const record = recordById.get(calendarId);

        return {
          calendarId,
          eventDate: record?.eventDate ?? '',
          time: record?.time ?? null,
          scheduledTimeLabel:
            this.studyReminderScheduleService.formatScheduledTimeLabel(
              session.scheduledAt,
            ),
          topic: session.topic || DEFAULT_TOPIC,
        };
      })
      .filter((entry): entry is StudyCalendarEntryView => entry !== null);

    return { timeRange, entries };
  }

  async rescheduleSession(params: {
    psid: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleStudySessionResult> {
    const source = await this.findCalendarRecord(
      params.psid,
      params.calendarId,
    );
    const timezone =
      this.studyReminderScheduleService.getOutboxSettings().timezone;
    const target = resolveRescheduleSlot({
      schedulingMode: params.schedulingMode,
      sourceEventDate: source.eventDate,
      sourceTime: source.time,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
      timezone,
    });

    this.assertFutureSlot(target.eventDate, target.time, timezone);

    await this.userCalendarApiService.deleteCalendar(
      params.psid,
      params.calendarId,
    );

    let created: UserCalendarRecord;
    try {
      created = await this.userCalendarApiService.createCalendar(
        params.psid,
        {
          eventDate: target.eventDate,
          time: target.time,
        },
        { userId: params.userId },
      );
    } catch (error) {
      this.logger.error(
        `Reschedule recreate failed after delete calendarId=${params.calendarId} psid=${params.psid}`,
      );
      throw error;
    }

    this.scheduleOutboxSync(params.userId);

    const scheduledAt = resolveScheduledAtFromEventDate(
      target.eventDate,
      target.time,
      timezone,
    );

    return {
      cancelledCalendarId: params.calendarId,
      created,
      schedulingMode: params.schedulingMode,
      scheduledTimeLabel:
        this.studyReminderScheduleService.formatScheduledTimeLabel(scheduledAt),
      outboxSyncQueued: true,
    };
  }

  private scheduleOutboxSync(userId: number): void {
    void this.studyReminderSyncService
      .syncUpcomingSessions({ userId })
      .then((sync) => {
        this.logger.log(
          `Background outbox sync userId=${userId}: upserted=${sync.upserted}, cancelled=${sync.cancelled}`,
        );
      })
      .catch((error) => {
        this.logger.error(
          `Background outbox sync failed userId=${userId}: ${errorMessage(
            error,
          )}`,
        );
      });
  }

  private async findCalendarRecord(
    psid: string,
    calendarId: number,
  ): Promise<UserCalendarRecord> {
    const source = await this.userCalendarScheduleService.findCalendarRecord(
      psid,
      calendarId,
    );

    if (!source) {
      throw new NotFoundException(
        `Calendar id=${calendarId} not found for this user`,
      );
    }

    return source;
  }

  private assertFutureSlot(
    eventDate: string,
    time: string,
    timezone: string,
  ): void {
    const scheduledAt = resolveScheduledAtFromEventDate(
      eventDate,
      time,
      timezone,
    );
    const minLeadMinutes =
      this.studyReminderScheduleService.getOutboxSettings().minLeadMinutes;

    const minutesUntil =
      this.studyReminderScheduleService.getMinutesUntilSession(scheduledAt);

    if (minutesUntil <= minLeadMinutes) {
      throw new BadRequestException(
        'Thời gian mới quá gần hoặc đã qua — chọn buổi học sắp tới hơn.',
      );
    }
  }
}
