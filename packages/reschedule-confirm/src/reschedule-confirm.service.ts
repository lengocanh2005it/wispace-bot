import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  errorMessage,
  maskExternalId,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import type {
  RescheduleSchedulingMode,
  UserCalendarRecord,
} from '@wispace/wispace-client';
import {
  MemoryRescheduleStore,
  type RescheduleStorePort,
  type RescheduleApprovalBinding,
} from './reschedule-store.port';

export const PENDING_RESCHEDULE_TTL_MS = 10 * 60 * 1000;
const APPROVAL_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidApprovalToken(value: string): boolean {
  return APPROVAL_TOKEN_RE.test(value);
}

export interface CalendarEntryView {
  calendarId: number;
  scheduledTimeLabel: string;
}

/** Rich calendar entry view produced by platform calendar services. */
export interface StudyCalendarEntryView {
  calendarId: number;
  eventDate: string;
  time: string | null;
  scheduledTimeLabel: string;
  topic: string;
}

export interface RescheduleResult {
  scheduledTimeLabel: string;
}

export interface RescheduleStudySessionResult {
  cancelledCalendarId: number;
  created: UserCalendarRecord;
  schedulingMode: RescheduleSchedulingMode;
  scheduledTimeLabel: string;
  /** Messenger only: whether the outbox sync was queued after reschedule. */
  outboxSyncQueued?: boolean;
}

export interface StageInput<TExternalId> {
  externalId: TExternalId;
  userId: number;
  calendarId: number;
  schedulingMode: RescheduleSchedulingMode;
  newLocalDate?: string;
  newTime?: string;
  platform?: string;
  mappingVersion?: string;
  intent?: string;
  canonicalArgs?: string;
}

export interface StageResult {
  pendingConfirmation: true;
  sessionLabel: string;
  summary: string;
  /** Opaque one-time approval token; non-enumerable for legacy response shapes. */
  confirmationToken?: string;
}

export interface ConfirmResult {
  confirmed: true;
  scheduledTimeLabel: string;
}

export interface ConfirmError {
  confirmed: false;
  message: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

export interface RescheduleConfirmationOptions<TExternalId> {
  /**
   * Runs after the reschedule write commits (#636) — bots wire cache
   * invalidation here so the next calendar read re-fetches. A hook failure
   * is logged and swallowed: the write already succeeded.
   */
  onConfirmed?: (externalId: TExternalId) => Promise<void> | void;
  /** #626: atomically consume one daily write-tool-budget unit for
   *  `reschedule_study_session` BEFORE the calendar write. Returns false when
   *  the learner is over their daily cap — confirm() then aborts with
   *  `rescheduleBudgetExceededMessage` and reverts the pending row. */
  consumeRescheduleBudget?: (
    userId: number,
    externalId: string,
  ) => Promise<boolean>;
  /** #626: refund the unit consumed above if `rescheduleSession` throws. */
  refundRescheduleBudget?: (
    userId: number,
    externalId: string,
  ) => Promise<void>;
  /** #626: Vietnamese reply shown when `consumeRescheduleBudget` returns false.
   *  Passed in (not imported) so this package keeps no llm-agent dependency. */
  rescheduleBudgetExceededMessage?: string;
}

/**
 * Generic reschedule confirmation service — handles the stage/confirm/cancel
 * flow for rescheduling study sessions. Platform-specific bots provide
 * CalendarPort and ReschedulePort implementations.
 *
 * Pending confirmations live in a `RescheduleStorePort` — the in-memory
 * default is per-instance; production wiring passes a DB-backed store so a
 * restart or another pod does not lose the pending confirmation.
 *
 * @template TExternalId - Platform-specific user ID type (psid, discordUserId, zaloUserId)
 */
@Injectable()
export class RescheduleConfirmationService<TExternalId> {
  private readonly logger = new Logger(RescheduleConfirmationService.name);
  private readonly store: RescheduleStorePort<TExternalId>;
  private readonly options: RescheduleConfirmationOptions<TExternalId>;

  constructor(
    private readonly calendarPort: CalendarPort<TExternalId>,
    private readonly reschedulePort: ReschedulePort<TExternalId>,
    store?: RescheduleStorePort<TExternalId>,
    options?: RescheduleConfirmationOptions<TExternalId>,
  ) {
    this.store = store ?? new MemoryRescheduleStore<TExternalId>();
    this.options = options ?? {};
  }

  async stage(
    input: StageInput<TExternalId>,
  ): Promise<StageResult | { error: string }> {
    if (
      this.store.requiresApprovalToken &&
      (!input.platform?.trim() ||
        !input.mappingVersion?.trim() ||
        !input.intent?.trim() ||
        !input.canonicalArgs?.trim())
    ) {
      return {
        error:
          'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

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
    const nonce = randomUUID();
    const intentHash = sha256((input.intent ?? '').trim());
    const argsHash = sha256(
      input.canonicalArgs ??
        JSON.stringify({
          calendarId: matchedEntry.calendarId,
          schedulingMode: input.schedulingMode,
          newLocalDate: input.newLocalDate ?? null,
          newTime: input.newTime ?? null,
        }),
    );

    await this.store.save({
      externalId: input.externalId,
      userId: input.userId,
      calendarId: matchedEntry.calendarId,
      schedulingMode: input.schedulingMode,
      newLocalDate: input.newLocalDate,
      newTime: input.newTime,
      sessionLabel,
      expiresAt: Date.now() + PENDING_RESCHEDULE_TTL_MS,
      toolName: 'reschedule_study_session',
      platform: input.platform,
      mappingVersion: input.mappingVersion,
      intentHash,
      argsHash,
      nonce,
    });

    this.logger.log(
      `RESCHEDULE_PENDING externalId=${maskExternalId(
        String(input.externalId),
      )} calendarId=${matchedEntry.calendarId} mode=${input.schedulingMode}`,
    );

    const result: StageResult = {
      pendingConfirmation: true,
      sessionLabel,
      summary,
    };
    Object.defineProperty(result, 'confirmationToken', {
      value: nonce,
      enumerable: false,
    });
    return result;
  }

  async confirm(
    externalId: TExternalId,
    userId?: number,
    approvalToken?: string,
    binding?: RescheduleApprovalBinding,
  ): Promise<ConfirmResult | ConfirmError> {
    if (
      this.store.requiresApprovalToken &&
      (!approvalToken ||
        !isValidApprovalToken(approvalToken) ||
        userId == null ||
        !binding?.platform ||
        !binding.mappingVersion)
    ) {
      return {
        confirmed: false,
        message:
          'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }
    const pending = await this.store.takeValid(externalId, userId, {
      ...binding,
      ...(approvalToken ? { nonce: approvalToken } : {}),
    });
    if (!pending) {
      return {
        confirmed: false,
        message:
          'Không còn yêu cầu đổi lịch đang chờ xác nhận. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    if (
      this.store.requiresApprovalToken &&
      (pending.toolName !== 'reschedule_study_session' ||
        !pending.intentHash ||
        !pending.argsHash ||
        !pending.nonce)
    ) {
      await this.store.revertToPending(externalId, pending.leaseToken);
      return {
        confirmed: false,
        message:
          'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    if (this.options.consumeRescheduleBudget) {
      const consumed = await this.options.consumeRescheduleBudget(
        pending.userId,
        String(pending.externalId),
      );
      if (!consumed) {
        await this.store.revertToPending(externalId, pending.leaseToken);
        this.logger.log(
          `RESCHEDULE_BUDGET_EXCEEDED externalId=${maskExternalId(String(externalId))}`,
        );
        return {
          confirmed: false,
          message:
            this.options.rescheduleBudgetExceededMessage ??
            'Bạn đã dùng hết số lần đổi lịch học trong hôm nay rồi. Bạn thử lại vào ngày mai nhé.',
        };
      }
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

      await this.store.cancel(externalId, pending.leaseToken);

      await this.runOnConfirmed(externalId);

      this.logger.log(
        `RESCHEDULE_CONFIRMED externalId=${maskExternalId(
          String(externalId),
        )} calendarId=${pending.calendarId}`,
      );

      return {
        confirmed: true,
        scheduledTimeLabel: result.scheduledTimeLabel,
      };
    } catch (error) {
      await this.options.refundRescheduleBudget?.(
        pending.userId,
        String(pending.externalId),
      );
      const message = errorMessage(error);
      this.logger.warn(
        `RESCHEDULE_CONFIRM_FAILED externalId=${maskExternalId(
          String(externalId),
        )}: ${sanitizeLogValue(message, 500)}`,
      );
      // Keep the confirmation pending so the user can tap confirm again —
      // a transient Wispace failure must not burn the staged request.
      await this.store.revertToPending(externalId, pending.leaseToken);
      return {
        confirmed: false,
        message:
          'Mình chưa đổi được lịch lúc này. Bạn thử lại sau hoặc đổi trực tiếp trên app WISPACE nhé.',
      };
    }
  }

  async cancel(
    externalId: TExternalId,
    approvalToken?: string,
  ): Promise<string> {
    if (
      this.store.requiresApprovalToken &&
      approvalToken !== undefined &&
      !isValidApprovalToken(approvalToken)
    ) {
      return 'Không thể xác thực yêu cầu đổi lịch này.';
    }
    await this.store.cancel(externalId, approvalToken);
    this.logger.log(
      `RESCHEDULE_CANCELLED externalId=${maskExternalId(String(externalId))}`,
    );
    return 'Đã hủy yêu cầu đổi lịch. Lịch học giữ nguyên nhé.';
  }

  /** Whether a valid (unexpired) pending reschedule exists for this user. */
  hasPending(externalId: TExternalId): Promise<boolean> {
    return this.store.hasPending(externalId);
  }

  private async runOnConfirmed(externalId: TExternalId): Promise<void> {
    if (!this.options.onConfirmed) {
      return;
    }
    try {
      await this.options.onConfirmed(externalId);
    } catch (error) {
      this.logger.warn(
        `RESCHEDULE_ON_CONFIRMED_HOOK_FAILED externalId=${maskExternalId(
          String(externalId),
        )}: ${sanitizeLogValue(errorMessage(error), 200)}`,
      );
    }
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
