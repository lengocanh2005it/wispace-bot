import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
  type RescheduleSchedulingMode,
  type UserCalendarRecord,
} from '@wispace/wispace-client';
import { formatScheduledTimeLabel } from '@wispace/study-reminder-core';
import { ZaloWispaceCalendarService } from '../../../wispace/application/services/zalo-wispace-calendar.service';
import { ZaloWispaceConfigService } from '../../../wispace/application/services/zalo-wispace-config.service';

export interface RescheduleStudySessionResult {
  cancelledCalendarId: number;
  created: UserCalendarRecord;
  schedulingMode: RescheduleSchedulingMode;
  scheduledTimeLabel: string;
}

@Injectable()
export class ZaloStudyCalendarCommandService {
  private readonly logger = new Logger(ZaloStudyCalendarCommandService.name);

  constructor(
    private readonly calendarService: ZaloWispaceCalendarService,
    private readonly configService: ZaloWispaceConfigService,
  ) {}

  async rescheduleSession(params: {
    zaloUserId: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleStudySessionResult> {
    const source = await this.findCalendarRecord(
      params.zaloUserId,
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

    await this.calendarService.deleteCalendar(
      params.zaloUserId,
      params.calendarId,
    );

    let created: UserCalendarRecord;
    try {
      created = await this.calendarService.createCalendar(
        params.zaloUserId,
        { eventDate: target.eventDate, time: target.time },
        { userId: params.userId },
      );
    } catch (error) {
      this.logger.error(
        `Reschedule recreate failed after delete calendarId=${params.calendarId} zaloUserId=${params.zaloUserId}`,
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
    zaloUserId: string,
    calendarId: number,
  ): Promise<UserCalendarRecord> {
    const source = await this.calendarService.findCalendarRecord(
      zaloUserId,
      calendarId,
    );

    if (!source) {
      throw new NotFoundException(
        `Calendar id=${calendarId} not found for this user`,
      );
    }

    return source;
  }
}
