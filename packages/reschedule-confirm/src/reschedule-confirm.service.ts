import { Injectable, Logger } from '@nestjs/common';
import type { RescheduleSchedulingMode } from '@wispace/wispace-client';

export const PENDING_RESCHEDULE_TTL_MS = 10 * 60 * 1000;

export interface CalendarEntryView {
  calendarId: number;
  scheduledTimeLabel: string;
}

export interface RescheduleResult {
  scheduledTimeLabel: string;
}

export interface StageInput<TExternalId> {
  externalId: TExternalId;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
}

export interface StageResult {
  pendingConfirmation: true;
  sessionLabel: string;
  summary: string;
}

export interface ConfirmResult {
  confirmed: true;
  scheduledTimeLabel: string;
}

export interface ConfirmError {
  confirmed: false;
  message: string;
}

/**
 * Calendar port — each bot implements this to list upcoming entries
 * using their platform-specific API.
 */
export interface CalendarPort<TExternalId> {
  listUpcomingEntries(
    externalId: TExternalId,
    userId: number,
  ): Promise<CalendarEntryView[]>;
}

/**
 * Reschedule port — each bot implements this to execute the actual
 * reschedule (delete + create) using their platform-specific API.
 */
export interface ReschedulePort<TExternalId> {
  rescheduleSession(params: {
    externalId: TExternalId;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<RescheduleResult>;
}

interface PendingReschedule<TExternalId> {
  externalId: TExternalId;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
  sessionLabel: string;
  expiresAt: number;
}

/**
 * Generic reschedule confirmation service — handles the stage/confirm/cancel
 * flow for rescheduling study sessions. Platform-specific bots provide
 * CalendarPort and ReschedulePort implementations.
 *
 * @template TExternalId - Platform-specific user ID type (psid, discordUserId, zaloUserId)
 */
@Injectable()
export class RescheduleConfirmationService<TExternalId> {
  private readonly logger = new Logger(RescheduleConfirmationService.name);
  private readonly pendingByExternalId = new Map<
    string,
    PendingReschedule<TExternalId>
  >();

  constructor(
    private readonly calendarPort: CalendarPort<TExternalId>,
    private readonly reschedulePort: ReschedulePort<TExternalId>,
  ) {}

  async stage(
    input: StageInput<TExternalId>,
  ): Promise<StageResult | { error: string }> {
    const upcoming = await this.calendarPort.listUpcomingEntries(
      input.externalId,
      input.userId,
    );
    const matchedEntry = upcoming.find(
      (entry) => entry.calendarId === input.calendarId,
    );
    if (!matchedEntry) {
      const options = upcoming
        .map((entry) => `${entry.calendarId} (${entry.scheduledTimeLabel})`)
        .join(', ');
      return {
        error: `calendarId ${input.calendarId} không có trong lịch sắp tới. Dùng đúng id từ list_study_calendar_entries${options ? `: ${options}` : ''}.`,
      };
    }

    const sessionLabel = matchedEntry.scheduledTimeLabel;
    const summary = this.buildSummary(input, sessionLabel);

    this.pendingByExternalId.set(String(input.externalId), {
      externalId: input.externalId,
      userId: input.userId,
      calendarId: matchedEntry.calendarId,
      schedulingMode: input.schedulingMode,
      newLocalDate: input.newLocalDate,
      newTime: input.newTime,
      sessionLabel,
      expiresAt: Date.now() + PENDING_RESCHEDULE_TTL_MS,
    });

    this.logger.log(
      `RESCHEDULE_PENDING externalId=${String(input.externalId)} calendarId=${matchedEntry.calendarId} mode=${input.schedulingMode}`,
    );

    return { pendingConfirmation: true, sessionLabel, summary };
  }

  async confirm(
    externalId: TExternalId,
    userId?: number,
  ): Promise<ConfirmResult | ConfirmError> {
    const pending = this.takePendingIfValid(externalId, userId);
    if (!pending) {
      return {
        confirmed: false,
        message:
          'Không còn yêu cầu đổi lịch đang chờ xác nhận. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    try {
      const result = await this.reschedulePort.rescheduleSession({
        externalId: pending.externalId,
        userId: pending.userId,
        calendarId: pending.calendarId,
        schedulingMode: pending.schedulingMode,
        newLocalDate: pending.newLocalDate,
        newTime: pending.newTime,
      });

      this.logger.log(
        `RESCHEDULE_CONFIRMED externalId=${String(externalId)} calendarId=${pending.calendarId}`,
      );

      return {
        confirmed: true,
        scheduledTimeLabel: result.scheduledTimeLabel,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `RESCHEDULE_CONFIRM_FAILED externalId=${String(externalId)}: ${message}`,
      );
      return {
        confirmed: false,
        message:
          'Mình chưa đổi được lịch lúc này. Bạn thử lại sau hoặc đổi trực tiếp trên app WISPACE nhé.',
      };
    }
  }

  cancel(externalId: TExternalId): string {
    this.pendingByExternalId.delete(String(externalId));
    this.logger.log(`RESCHEDULE_CANCELLED externalId=${String(externalId)}`);
    return 'Đã hủy yêu cầu đổi lịch. Lịch học giữ nguyên nhé.';
  }

  /** Whether a valid (unexpired) pending reschedule exists for this user. */
  hasPending(externalId: TExternalId): boolean {
    const pending = this.pendingByExternalId.get(String(externalId));
    if (!pending) {
      return false;
    }
    if (pending.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(String(externalId));
      return false;
    }
    return true;
  }

  private takePendingIfValid(
    externalId: TExternalId,
    userId?: number,
  ): PendingReschedule<TExternalId> | undefined {
    const pending = this.pendingByExternalId.get(String(externalId));
    if (!pending) {
      return undefined;
    }

    if (pending.expiresAt <= Date.now()) {
      this.pendingByExternalId.delete(String(externalId));
      return undefined;
    }

    if (userId != null && pending.userId !== userId) {
      return undefined;
    }

    this.pendingByExternalId.delete(String(externalId));
    return pending;
  }

  private buildSummary(
    input: StageInput<TExternalId>,
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
