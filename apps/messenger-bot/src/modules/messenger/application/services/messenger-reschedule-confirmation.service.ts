import { Injectable, Logger } from '@nestjs/common';
import { StudyCalendarCommandService } from '../../../study-reminder/application/services/study-calendar-command.service';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';
import { buildRescheduleConfirmFollowUp } from '../formatters/messenger-rich-message.builder';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import {
  CANCEL_RESCHEDULE_POSTBACK,
  CONFIRM_RESCHEDULE_POSTBACK,
  PENDING_RESCHEDULE_TTL_MS,
} from '../constants/messenger-reschedule.constants';

interface PendingReschedule {
  psid: string;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
  sessionLabel: string;
  expiresAt: number;
}

export interface StageRescheduleInput {
  psid: string;
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
  richFollowUp: MessengerRichFollowUp;
}

@Injectable()
export class MessengerRescheduleConfirmationService {
  private readonly logger = new Logger(
    MessengerRescheduleConfirmationService.name,
  );
  private readonly pendingByPsid = new Map<string, PendingReschedule>();

  constructor(
    private readonly studyCalendarCommandService: StudyCalendarCommandService,
  ) {}

  async stage(
    input: StageRescheduleInput,
  ): Promise<StageRescheduleResult | { error: string }> {
    const upcoming = await this.studyCalendarCommandService.listEntries(
      input.psid,
      input.userId,
      { timeRange: 'upcoming' },
    );
    const matchedEntry = upcoming.entries.find(
      (entry) => entry.calendarId === input.calendarId,
    );
    if (!matchedEntry) {
      const options = upcoming.entries
        .map((entry) => `${entry.calendarId} (${entry.scheduledTimeLabel})`)
        .join(', ');
      return {
        error: `calendarId ${input.calendarId} không có trong lịch sắp tới. Dùng đúng id từ list_study_calendar_entries${options ? `: ${options}` : ''}.`,
      };
    }

    const sessionLabel = matchedEntry.scheduledTimeLabel;
    const summary = this.buildSummary(input, sessionLabel);

    this.pendingByPsid.set(input.psid, {
      psid: input.psid,
      userId: input.userId,
      calendarId: matchedEntry.calendarId,
      schedulingMode: input.schedulingMode,
      newLocalDate: input.newLocalDate,
      newTime: input.newTime,
      sessionLabel,
      expiresAt: Date.now() + PENDING_RESCHEDULE_TTL_MS,
    });

    this.logger.log(
      `RESCHEDULE_PENDING psid=${input.psid} calendarId=${matchedEntry.calendarId} mode=${input.schedulingMode}`,
    );

    return {
      pendingConfirmation: true,
      sessionLabel,
      summary,
      richFollowUp: buildRescheduleConfirmFollowUp({ summary }),
    };
  }

  async confirm(
    psid: string,
    userId?: number,
  ): Promise<
    | { confirmed: true; scheduledTimeLabel: string }
    | { confirmed: false; message: string }
  > {
    const pending = this.takePendingIfValid(psid, userId);
    if (!pending) {
      return {
        confirmed: false,
        message:
          'Không còn yêu cầu đổi lịch đang chờ xác nhận. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    try {
      const result = await this.studyCalendarCommandService.rescheduleSession({
        psid: pending.psid,
        userId: pending.userId,
        calendarId: pending.calendarId,
        schedulingMode: pending.schedulingMode,
        newLocalDate: pending.newLocalDate,
        newTime: pending.newTime,
      });

      this.logger.log(
        `RESCHEDULE_CONFIRMED psid=${psid} calendarId=${pending.calendarId}`,
      );

      return {
        confirmed: true,
        scheduledTimeLabel: result.scheduledTimeLabel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`RESCHEDULE_CONFIRM_FAILED psid=${psid}: ${message}`);
      return {
        confirmed: false,
        message:
          'Mình chưa đổi được lịch lúc này. Bạn thử lại sau hoặc đổi trực tiếp trên app WISPACE nhé.',
      };
    }
  }

  cancel(psid: string): string {
    this.pendingByPsid.delete(psid);
    this.logger.log(`RESCHEDULE_CANCELLED psid=${psid}`);
    return 'Đã hủy yêu cầu đổi lịch. Lịch học giữ nguyên nhé.';
  }

  private takePendingIfValid(
    psid: string,
    userId?: number,
  ): PendingReschedule | undefined {
    const pending = this.pendingByPsid.get(psid);
    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingByPsid.delete(psid);
      return undefined;
    }

    if (userId != null && pending.userId !== userId) {
      return undefined;
    }

    this.pendingByPsid.delete(psid);
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

  /** Exposed for tests — postback payload constants. */
  static readonly confirmPayload = CONFIRM_RESCHEDULE_POSTBACK;
  static readonly cancelPayload = CANCEL_RESCHEDULE_POSTBACK;
}
