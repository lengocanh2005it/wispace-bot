import { Injectable, Logger } from '@nestjs/common';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { ZaloStudyCalendarCommandService } from './zalo-study-calendar-command.service';
import { ZaloWispaceCalendarService } from '../../../wispace/application/services/zalo-wispace-calendar.service';
import { PENDING_RESCHEDULE_TTL_MS } from '../constants/zalo-reschedule.constants';

interface PendingReschedule {
  zaloUserId: string;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
  sessionLabel: string;
  expiresAt: number;
}

export interface StageRescheduleInput {
  zaloUserId: string;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
}

export interface StageRescheduleResult {
  pendingConfirmation: true;
  sessionLabel: string;
  summary: string;
}

/**
 * Zalo counterpart to Messenger's `MessengerRescheduleConfirmationService`
 * — stages a pending reschedule keyed by zaloUserId, confirmed/cancelled
 * via text reply keywords (xác nhận/hủy) instead of buttons.
 */
@Injectable()
export class ZaloRescheduleConfirmationService {
  private readonly logger = new Logger(ZaloRescheduleConfirmationService.name);
  private readonly pendingByZaloUserId = new Map<string, PendingReschedule>();

  constructor(
    private readonly studyCalendarCommandService: ZaloStudyCalendarCommandService,
    private readonly calendarService: ZaloWispaceCalendarService,
  ) {}

  async stage(
    input: StageRescheduleInput,
  ): Promise<StageRescheduleResult | { error: string }> {
    const records = await this.calendarService.listCalendars(input.zaloUserId);
    const matchedRecord = records.find(
      (record) => record.id === input.calendarId,
    );

    if (!matchedRecord) {
      const options = records
        .map(
          (record) => `${record.id} (${record.eventDate} ${record.time ?? ''})`,
        )
        .join(', ');
      return {
        error: `calendarId ${input.calendarId} không có trong lịch sắp tới. Dùng đúng id từ list_study_calendar_entries${options ? `: ${options}` : ''}.`,
      };
    }

    const sessionLabel =
      `${matchedRecord.eventDate} ${matchedRecord.time ?? ''}`.trim();
    const summary = this.buildSummary(input, sessionLabel);

    this.pendingByZaloUserId.set(input.zaloUserId, {
      zaloUserId: input.zaloUserId,
      userId: input.userId,
      calendarId: matchedRecord.id,
      schedulingMode: input.schedulingMode,
      newLocalDate: input.newLocalDate,
      newTime: input.newTime,
      sessionLabel,
      expiresAt: Date.now() + PENDING_RESCHEDULE_TTL_MS,
    });

    this.logger.log(
      `RESCHEDULE_PENDING zaloUserId=${input.zaloUserId} calendarId=${matchedRecord.id} mode=${input.schedulingMode}`,
    );

    return { pendingConfirmation: true, sessionLabel, summary };
  }

  async confirm(
    zaloUserId: string,
    userId?: number,
  ): Promise<
    | { confirmed: true; scheduledTimeLabel: string }
    | { confirmed: false; message: string }
  > {
    const pending = this.takePendingIfValid(zaloUserId, userId);
    if (!pending) {
      return {
        confirmed: false,
        message:
          'Không còn yêu cầu đổi lịch đang chờ xác nhận. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    try {
      const result = await this.studyCalendarCommandService.rescheduleSession({
        zaloUserId: pending.zaloUserId,
        userId: pending.userId,
        calendarId: pending.calendarId,
        schedulingMode: pending.schedulingMode,
        newLocalDate: pending.newLocalDate,
        newTime: pending.newTime,
      });

      this.logger.log(
        `RESCHEDULE_CONFIRMED zaloUserId=${zaloUserId} calendarId=${pending.calendarId}`,
      );

      return {
        confirmed: true,
        scheduledTimeLabel: result.scheduledTimeLabel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `RESCHEDULE_CONFIRM_FAILED zaloUserId=${zaloUserId}: ${message}`,
      );
      return {
        confirmed: false,
        message:
          'Mình chưa đổi được lịch lúc này. Bạn thử lại sau hoặc đổi trực tiếp trên app WISPACE nhé.',
      };
    }
  }

  cancel(zaloUserId: string): string {
    this.pendingByZaloUserId.delete(zaloUserId);
    this.logger.log(`RESCHEDULE_CANCELLED zaloUserId=${zaloUserId}`);
    return 'Đã hủy yêu cầu đổi lịch. Lịch học giữ nguyên nhé.';
  }

  private takePendingIfValid(
    zaloUserId: string,
    userId?: number,
  ): PendingReschedule | undefined {
    const pending = this.pendingByZaloUserId.get(zaloUserId);
    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingByZaloUserId.delete(zaloUserId);
      return undefined;
    }

    if (userId != null && pending.userId !== userId) {
      return undefined;
    }

    this.pendingByZaloUserId.delete(zaloUserId);
    return pending;
  }

  private buildSummary(
    input: StageRescheduleInput,
    sessionLabel: string,
  ): string {
    if (input.schedulingMode === 'explicit') {
      const datePart = input.newLocalDate ? `ngày ${input.newLocalDate}` : '';
      const timePart = input.newTime ? `lúc ${input.newTime}` : '';
      const target = [datePart, timePart].filter(Boolean).join(' ');
      return target
        ? `Dời buổi ${sessionLabel} sang ${target}?`
        : `Dời buổi ${sessionLabel} theo thời gian bạn vừa nêu?`;
    }

    return `Dời buổi ${sessionLabel} sang ngày kế tiếp cùng giờ?`;
  }
}
