import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import type {
  RescheduleStudySessionResult,
  StudyCalendarEntryView,
} from '@wispace/reschedule-confirm';
import {
  PlatformStudyCalendarCommandService,
  StudyReminderSyncService,
  createSessionSourceGetSessions,
} from '@wispace/study-reminder-shared';
import type {
  CalendarSessionTimeRange,
  RescheduleSchedulingMode,
} from '@wispace/wispace-client';
import { StudySessionSourceService } from '../../application/services/study-session-source.service';

@Injectable()
export class StudyCalendarCommandService {
  private readonly logger = new Logger(StudyCalendarCommandService.name);

  constructor(
    private readonly calendarCommand: PlatformStudyCalendarCommandService,
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
      signal?: AbortSignal;
    },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }> {
    const timeRange = options?.timeRange ?? 'upcoming';
    try {
      return await this.calendarCommand.listEntries(psid, {
        ...options,
        ...(userId !== undefined ? { userId } : {}),
      });
    } catch (error) {
      if (userId !== undefined || isAbortError(error)) {
        throw error;
      }

      this.logger.warn(
        `Unscoped calendar read failed psid=${maskExternalId(
          psid,
        )}: ${errorMessage(error)}`,
      );
      return { timeRange, entries: [] };
    }
  }

  async rescheduleSession(params: {
    psid: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleStudySessionResult & { outboxSyncQueued: true }> {
    const result = await this.calendarCommand.rescheduleSession({
      externalUserId: params.psid,
      userId: params.userId,
      calendarId: params.calendarId,
      schedulingMode: params.schedulingMode,
      newLocalDate: params.newLocalDate,
      newTime: params.newTime,
    });

    this.scheduleOutboxSync(params.userId);
    return { ...result, outboxSyncQueued: true };
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
}
