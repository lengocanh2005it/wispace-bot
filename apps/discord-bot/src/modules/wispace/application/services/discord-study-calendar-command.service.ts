import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  type CalendarSessionTimeRange,
  type RescheduleSchedulingMode,
  type UserCalendarRecord,
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
} from '@wispace/wispace-client';
import type {
  RescheduleStudySessionResult,
  StudyCalendarEntryView,
} from '@wispace/reschedule-confirm';
import {
  formatScheduledTimeLabel,
  getMinutesUntilSession,
} from '@wispace/study-reminder-core';
import {
  WispaceCalendarService,
  WispaceConfigService,
} from '@wispace/wispace-client';

/**
 * Discord counterpart to Messenger's `StudyCalendarCommandService` — reuses
 * the same write-capable Wispace calendar client + pure scheduling math
 * (`@wispace/wispace-client`, `@wispace/study-reminder-core`). No outbox
 * sync afterwards: Discord has no study-reminder job system yet (Phase 3
 * gap, see docs/turborepo-migration-plan.md).
 */
@Injectable()
export class DiscordStudyCalendarCommandService {
  private readonly logger = new Logger(DiscordStudyCalendarCommandService.name);

  constructor(
    private readonly calendarService: WispaceCalendarService,
    private readonly configService: WispaceConfigService,
  ) {}

  async listEntries(
    discordUserId: string,
    options?: { timeRange?: CalendarSessionTimeRange; limit?: number },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }> {
    const timeRange = options?.timeRange ?? 'upcoming';
    const records = await this.calendarService.listCalendars(discordUserId);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const sessions = await this.calendarService.getCalendarSessions(
      discordUserId,
      { timeRange, limit: options?.limit },
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
          scheduledTimeLabel: formatScheduledTimeLabel(
            session.scheduledAt,
            this.configService.getTimezone(),
          ),
          topic: session.topic || 'IELTS Writing',
        };
      })
      .filter((entry): entry is StudyCalendarEntryView => entry !== null);

    return { timeRange, entries };
  }

  async rescheduleSession(params: {
    discordUserId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleStudySessionResult> {
    const source = await this.findCalendarRecord(
      params.discordUserId,
      params.calendarId,
    );
    const timezone = this.configService.getTimezone();
    const target = resolveRescheduleSlot({
      schedulingMode: params.schedulingMode,
      sourceEventDate: source.eventDate,
      sourceTime: source.time,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
      timezone,
    });

    this.assertFutureSlot(target.eventDate, target.time, timezone);

    await this.calendarService.deleteCalendar(
      params.discordUserId,
      params.calendarId,
    );

    let created: UserCalendarRecord;
    try {
      created = await this.calendarService.createCalendar(
        params.discordUserId,
        { eventDate: target.eventDate, time: target.time },
        { userId: params.userId },
      );
    } catch (error) {
      this.logger.error(
        `Reschedule recreate failed after delete calendarId=${params.calendarId} discordUserId=${params.discordUserId}`,
      );
      throw error;
    }

    const scheduledAt = resolveScheduledAtFromEventDate(
      target.eventDate,
      target.time,
      timezone,
    );

    return {
      cancelledCalendarId: params.calendarId,
      created,
      schedulingMode: params.schedulingMode,
      scheduledTimeLabel: formatScheduledTimeLabel(scheduledAt, timezone),
    };
  }

  private async findCalendarRecord(
    discordUserId: string,
    calendarId: number,
  ): Promise<UserCalendarRecord> {
    const source = await this.calendarService.findCalendarRecord(
      discordUserId,
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
    const minutesUntil = getMinutesUntilSession(scheduledAt);

    if (minutesUntil <= this.configService.getMinLeadMinutes()) {
      throw new BadRequestException(
        'Thời gian mới quá gần hoặc đã qua — chọn buổi học sắp tới hơn.',
      );
    }
  }
}
