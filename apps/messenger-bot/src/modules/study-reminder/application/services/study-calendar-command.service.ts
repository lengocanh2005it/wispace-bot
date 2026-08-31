import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { CalendarSessionTimeRange } from '../../domain/entities/study-schedule.types';
import { UserCalendarRecord } from '../../domain/entities/user-calendar.types';
import {
  USER_CALENDAR_DATA_PORT,
  type UserCalendarDataPort,
} from '../../domain/ports/user-calendar-data.port';
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
import { createSessionSourceGetSessions } from '@wispace/study-reminder-shared';
import { addHours } from 'date-fns';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';
import { StudySessionSourceService } from './study-session-source.service';

@Injectable()
export class StudyCalendarCommandService {
  private readonly logger = new Logger(StudyCalendarCommandService.name);

  constructor(
    @Inject(USER_CALENDAR_DATA_PORT)
    private readonly calendarData: UserCalendarDataPort,
    private readonly studyReminderScheduleService: StudyReminderScheduleService,
    private readonly studyReminderSyncService: StudyReminderSyncService,
    private readonly sessionSourceService: StudySessionSourceService,
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
    const records = await this.calendarData.listCalendars(psid);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const { syncHorizonHours } =
      this.studyReminderScheduleService.getOutboxSettings();
    const horizonEnd = addHours(new Date(), syncHorizonHours);
    const sessions = await this.calendarData.getCalendarSessions(
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
    // One calendar GET per confirmation (#455): the same snapshot drives the
    // source lookup and the idempotent-create duplicate check.
    const records = await this.calendarData.listCalendars(params.psid);
    const source = records.find((record) => record.id === params.calendarId);
    if (!source) {
      throw new NotFoundException(
        `Calendar id=${params.calendarId} not found for this user`,
      );
    }
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

    // CREATE-FIRST: the original session is never deleted before the
    // replacement exists, so a failure can never leave the user with no
    // session. Retrying converges: an already-created replacement is reused
    // instead of duplicated (#114).
    let created: UserCalendarRecord;
    try {
      created = await this.createTargetIdempotent(
        params.psid,
        records,
        target.eventDate,
        target.time,
        params.userId,
      );
    } catch (error) {
      // Original session is untouched — the confirmation flow keeps the
      // request pending so the user can simply try again.
      this.logger.error(
        `Reschedule create failed calendarId=${params.calendarId} psid=${maskExternalId(
          params.psid,
        )}`,
      );
      throw error;
    }

    // Only now remove the source, with bounded retries. If deletion still
    // fails both sessions exist; the replacement is live and a retry of the
    // confirmation converges (createTargetIdempotent skips the duplicate).
    try {
      await this.deleteWithRetry(params.psid, params.calendarId);
    } catch (error) {
      this.logger.error(
        `Reschedule delete failed after create calendarId=${params.calendarId} psid=${maskExternalId(
          params.psid,
        )} — duplicate session may exist on WISPACE`,
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
      .syncUpcomingSessions({
        userId,
        // Authoritative calendar fetch before any stale-job cancellation.
        getSessions: createSessionSourceGetSessions(this.sessionSourceService),
      })
      .then((sync) => {
        this.logger.log(
          `Background outbox sync userId=${maskExternalId(
            userId,
          )}: upserted=${sync.upserted}, cancelled=${sync.cancelled}`,
        );
      })
      .catch((error) => {
        this.logger.error(
          `Background outbox sync failed userId=${maskExternalId(
            userId,
          )}: ${errorMessage(error)}`,
        );
      });
  }

  /**
   * Creates the replacement slot unless one already exists (idempotent retry
   * after a crash between create and delete — never a duplicate replacement).
   * Reuses the flow's already-fetched records — no second list GET (#455).
   */
  private async createTargetIdempotent(
    psid: string,
    records: UserCalendarRecord[],
    eventDate: string,
    time: string,
    userId: number,
  ): Promise<UserCalendarRecord> {
    const existing = records.find(
      (record) => record.eventDate === eventDate && record.time === time,
    );
    if (existing) {
      this.logger.log(
        `Reschedule target already exists calendarId=${existing.id} — reusing it (idempotent retry)`,
      );
      return existing;
    }
    return this.calendarData.createCalendar(
      psid,
      { eventDate, time },
      { userId },
    );
  }

  private async deleteWithRetry(
    psid: string,
    calendarId: number,
  ): Promise<void> {
    let lastError: unknown;
    for (const delayMs of [0, 300, 700]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        await this.calendarData.deleteCalendar(psid, calendarId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('unknown delete error');
  }

  private async findCalendarRecord(
    psid: string,
    calendarId: number,
  ): Promise<UserCalendarRecord> {
    const source = await this.calendarData.findCalendarRecord(psid, calendarId);

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
