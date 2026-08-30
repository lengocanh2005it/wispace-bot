import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import { sleep } from '@wispace/bot-common/utils';
import {
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
  type CalendarSessionTimeRange,
  type RescheduleSchedulingMode,
  type UserCalendarRecord,
} from '@wispace/wispace-client';
import type {
  RescheduleConfigPort,
  StudyCalendarPort,
} from '../ports/study-calendar.port';
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
 * shared by the Discord and Zalo bots. Consumes the structural calendar
 * port (`StudyCalendarPort`) + scheduling config (`RescheduleConfigPort`) —
 * concrete WISPACE adapters are wired at each bot's composition root (#424).
 */
export class PlatformStudyCalendarCommandService {
  private readonly logger = new Logger(
    PlatformStudyCalendarCommandService.name,
  );

  constructor(
    private readonly options: PlatformStudyCalendarCommandOptions,
    private readonly calendarService: StudyCalendarPort,
    private readonly configService: RescheduleConfigPort,
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

    // CREATE-FIRST: the original session is never deleted before the
    // replacement exists, so a failure can never leave the user with no
    // session. Retrying converges: an already-created replacement is reused
    // instead of duplicated (#114).
    let created: UserCalendarRecord;
    try {
      created = await this.createTargetIdempotent(
        params.externalUserId,
        target.eventDate,
        target.time,
        params.userId,
      );
    } catch (error) {
      // Original session is untouched — the confirmation flow keeps the
      // request pending so the user can simply try again.
      this.logger.error(
        `Reschedule create failed calendarId=${params.calendarId} ${this.options.platform}UserId=${maskExternalId(
          params.externalUserId,
        )}`,
      );
      throw error;
    }

    // Only now remove the source, with bounded retries. If deletion still
    // fails both sessions exist; the replacement is live and a retry of the
    // confirmation converges (createTargetIdempotent skips the duplicate).
    try {
      await this.deleteWithRetry(params.externalUserId, params.calendarId);
    } catch (error) {
      this.logger.error(
        `Reschedule delete failed after create calendarId=${params.calendarId} ${this.options.platform}UserId=${maskExternalId(
          params.externalUserId,
        )} — duplicate session may exist on WISPACE`,
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

  /**
   * Creates the replacement slot unless one already exists (idempotent retry
   * after a crash between create and delete — never a duplicate replacement).
   */
  private async createTargetIdempotent(
    externalUserId: string,
    eventDate: string,
    time: string,
    userId: number,
  ): Promise<UserCalendarRecord> {
    const records = await this.calendarService.listCalendars(externalUserId);
    const existing = records.find(
      (record) => record.eventDate === eventDate && record.time === time,
    );
    if (existing) {
      this.logger.log(
        `Reschedule target already exists calendarId=${existing.id} — reusing it (idempotent retry)`,
      );
      return existing;
    }
    return this.calendarService.createCalendar(
      externalUserId,
      { eventDate, time },
      { userId },
    );
  }

  private async deleteWithRetry(
    externalUserId: string,
    calendarId: number,
  ): Promise<void> {
    let lastError: unknown;
    for (const delayMs of [0, 300, 700]) {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        await this.calendarService.deleteCalendar(externalUserId, calendarId);
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
