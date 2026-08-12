import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common';
import {
  WispaceCalendarService,
  WispaceConfigService,
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
  type CalendarSessionTimeRange,
  type RescheduleSchedulingMode,
  type UserCalendarRecord,
} from '@wispace/wispace-client';
import type {
  RescheduleStudySessionResult,
  StudyCalendarEntryView,
} from '@wispace/reschedule-confirm';
import {
  formatScheduledTimeLabel,
  getMinutesUntilSession,
} from '../utils/schedule';

export interface PlatformStudyCalendarCommandOptions {
  /** Platform label used in log lines, e.g. `discord` → `discordUserId=...`. */
  platform: string;
  /**
   * Reject target slots that are too close / already past (discord);
   * zalo skips this check.
   */
  enforceLeadTime?: boolean;
}

/**
 * Delete-recreate calendar reschedule flow + upcoming-session listing,
 * shared by the Discord and Zalo bots. Uses the same write-capable Wispace
 * calendar client + pure scheduling math as messenger-bot's
 * `StudyCalendarCommandService`.
 */
export class PlatformStudyCalendarCommandService {
  private readonly logger = new Logger(
    PlatformStudyCalendarCommandService.name,
  );

  constructor(
    private readonly options: PlatformStudyCalendarCommandOptions,
    private readonly calendarService: WispaceCalendarService,
    private readonly configService: WispaceConfigService,
  ) {}

  async listEntries(
    externalUserId: string,
    options?: { timeRange?: CalendarSessionTimeRange; limit?: number },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }> {
    const timeRange = options?.timeRange ?? 'upcoming';
    const records = await this.calendarService.listCalendars(externalUserId);
    const recordById = new Map(records.map((record) => [record.id, record]));
    const sessions = await this.calendarService.getCalendarSessions(
      externalUserId,
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
    externalUserId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleStudySessionResult> {
    const source = await this.findCalendarRecord(
      params.externalUserId,
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

    if (this.options.enforceLeadTime === true) {
      this.assertFutureSlot(target.eventDate, target.time, timezone);
    }

    await this.calendarService.deleteCalendar(
      params.externalUserId,
      params.calendarId,
    );

    let created: UserCalendarRecord;
    try {
      created = await this.calendarService.createCalendar(
        params.externalUserId,
        { eventDate: target.eventDate, time: target.time },
        { userId: params.userId },
      );
    } catch (error) {
      this.logger.error(
        `Reschedule recreate failed after delete calendarId=${params.calendarId} ${this.options.platform}UserId=${maskExternalId(
          params.externalUserId,
        )}`,
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
    externalUserId: string,
    calendarId: number,
  ): Promise<UserCalendarRecord> {
    const source = await this.calendarService.findCalendarRecord(
      externalUserId,
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
