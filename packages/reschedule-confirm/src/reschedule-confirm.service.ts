import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  errorMessage,
  maskExternalId,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import type {
  RescheduleSchedulingMode,
  UserCalendarRecord,
} from '@wispace/wispace-client';
import {
  MemoryRescheduleStore,
  type RescheduleStorePort,
  type RescheduleApprovalBinding,
  type RescheduleCancellationOutcome,
  type ReschedulePendingState,
} from './reschedule-store.port';

export const PENDING_RESCHEDULE_TTL_MS = 10 * 60 * 1000;

/**
 * Generic "couldn't reschedule right now" reply — used for a transient WISPACE
 * failure and as the last-resort fallback when the caller wired
 * `consumeRescheduleBudget` but not `rescheduleBudgetExceededMessage` (#626).
 * The canonical budget-exhausted copy lives in `@wispace/llm-agent`
 * (`buildWriteToolDailyBudgetMessage`) and is always passed in by the apps.
 */
const RESCHEDULE_UNAVAILABLE_MESSAGE =
  'Mình chưa đổi được lịch lúc này. Bạn thử lại sau hoặc đổi trực tiếp trên app WISPACE nhé.';

export const RESCHEDULE_IN_PROGRESS_MESSAGE =
  'Yêu cầu đổi lịch trước đang được xử lý. Bạn thử lại sau nhé.';

export const RESCHEDULE_SCOPE_ERROR_MESSAGE =
  'Không thể xác thực buổi học này trong lịch của bạn. Bạn chọn lại từ danh sách lịch học nhé.';

export const RESCHEDULE_CANCELLED_MESSAGE =
  'Đã hủy yêu cầu đổi lịch. Lịch học giữ nguyên nhé.';
export const RESCHEDULE_CANCEL_PROCESSING_MESSAGE =
  'Yêu cầu đổi lịch đã bắt đầu xử lý nên mình không thể dừng giữa chừng. Mình sẽ báo kết quả khi xong nhé.';
export const RESCHEDULE_CANCEL_NONE_MESSAGE =
  'Mình không thấy yêu cầu đổi lịch nào đang chờ xác nhận.';
export const RESCHEDULE_EXPIRED_MESSAGE =
  'Yêu cầu đổi lịch đã hết hạn. Bạn nhắn lại nhu cầu đổi lịch để tạo yêu cầu mới nhé.';
export const RESCHEDULE_CONFIRM_TOKEN_REQUIRED_MESSAGE =
  'Bạn hãy bấm đúng nút xác nhận hoặc nhắn "xác nhận <mã>" để mình thực hiện đổi lịch nhé.';
export const RESCHEDULE_INVALID_TOKEN_MESSAGE =
  'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.';

export type RescheduleScopeFailureReason =
  | 'scope_mismatch'
  | 'scope_unverified';

/** Deterministic ownership failure; callers must not retry or mutate. */
export class RescheduleScopeError extends Error {
  constructor(readonly reason: RescheduleScopeFailureReason) {
    super(`Calendar scope ${reason}`);
    this.name = RescheduleScopeError.name;
  }
}

/** Internal cancellation marker for an abandoned staging attempt. */
export class RescheduleStageAbortedError extends Error {
  readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('Reschedule staging aborted');
    this.name = 'AbortError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function throwIfStageAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RescheduleStageAbortedError(signal.reason);
  }
}

export function getRescheduleScopeFailureReason(
  ownerUserId: unknown,
  expectedUserId: unknown,
): RescheduleScopeFailureReason | undefined {
  if (
    typeof ownerUserId !== 'number' ||
    !Number.isSafeInteger(ownerUserId) ||
    ownerUserId <= 0 ||
    typeof expectedUserId !== 'number' ||
    !Number.isSafeInteger(expectedUserId) ||
    expectedUserId <= 0
  ) {
    return 'scope_unverified';
  }
  return ownerUserId === expectedUserId ? undefined : 'scope_mismatch';
}

export function assertRescheduleRecordOwnership(
  record: Pick<UserCalendarRecord, 'userId'>,
  expectedUserId: number,
): void {
  const reason = getRescheduleScopeFailureReason(record.userId, expectedUserId);
  if (reason) {
    throw new RescheduleScopeError(reason);
  }
}

const APPROVAL_TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidApprovalToken(value: string): boolean {
  return APPROVAL_TOKEN_RE.test(value);
}

export interface CalendarEntryView {
  calendarId: number;
  scheduledTimeLabel: string;
  /** Internal ownership proof; strip before returning model-facing data. */
  ownerUserId?: number;
}

/** Rich calendar entry view produced by platform calendar services. */
export interface StudyCalendarEntryView {
  calendarId: number;
  eventDate: string;
  time: string | null;
  scheduledTimeLabel: string;
  topic: string;
  /** Internal ownership proof; strip before returning model-facing data. */
  ownerUserId?: number;
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
  signal?: AbortSignal;
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
    options?: { signal?: AbortSignal },
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

/** Drops cached calendar reads after a committed reschedule write. */
export interface CalendarCacheInvalidationPort<TExternalId> {
  invalidateCalendar(externalUserId: TExternalId): void;
}

export interface RescheduleConfirmationOptions<TExternalId> {
  /**
   * Drops cached calendar reads after the reschedule write commits (#705).
   * An invalidation failure is logged and swallowed: the write already
   * succeeded.
   */
  calendarCacheInvalidation?: CalendarCacheInvalidationPort<TExternalId>;
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
  /** Bounded scope-mismatch telemetry; no identifiers are passed. */
  scopeFailureInc?: (reason: RescheduleScopeFailureReason) => void;
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
    throwIfStageAborted(input.signal);
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

    let upcoming: CalendarEntryView[];
    try {
      upcoming = input.signal
        ? await this.calendarPort.listUpcomingEntries(
            input.externalId,
            input.userId,
            { signal: input.signal },
          )
        : await this.calendarPort.listUpcomingEntries(
            input.externalId,
            input.userId,
          );
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        throw new RescheduleStageAbortedError(error);
      }
      throw error;
    }
    throwIfStageAborted(input.signal);
    const matchedEntry = upcoming.find(
      (entry) => entry.calendarId === input.calendarId,
    );
    if (!matchedEntry) {
      this.recordScopeFailure(
        input.externalId,
        'scope_unverified',
        input.calendarId,
      );
      return { error: RESCHEDULE_SCOPE_ERROR_MESSAGE };
    }

    const scopeFailure = getRescheduleScopeFailureReason(
      matchedEntry.ownerUserId,
      input.userId,
    );
    if (scopeFailure) {
      this.recordScopeFailure(
        input.externalId,
        scopeFailure,
        matchedEntry.calendarId,
        matchedEntry.ownerUserId,
      );
      return { error: RESCHEDULE_SCOPE_ERROR_MESSAGE };
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

    throwIfStageAborted(input.signal);

    const pendingRecord = {
      externalId: input.externalId,
      userId: input.userId,
      calendarId: matchedEntry.calendarId,
      schedulingMode: input.schedulingMode,
      newLocalDate: input.newLocalDate,
      newTime: input.newTime,
      sessionLabel,
      expiresAt: Date.now() + PENDING_RESCHEDULE_TTL_MS,
      toolName: 'reschedule_study_session' as const,
      platform: input.platform,
      mappingVersion: input.mappingVersion,
      intentHash,
      argsHash,
      nonce,
    };
    let saved: boolean;
    try {
      saved = input.signal
        ? await this.store.save(pendingRecord, { signal: input.signal })
        : await this.store.save(pendingRecord);
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        await this.cancelPending(input.externalId, nonce);
        throw new RescheduleStageAbortedError(error);
      }
      throw error;
    }

    if (input.signal?.aborted) {
      await this.cancelPending(input.externalId, nonce);
      throw new RescheduleStageAbortedError(input.signal.reason);
    }

    if (!saved) {
      return { error: RESCHEDULE_IN_PROGRESS_MESSAGE };
    }

    this.logger.log(
      `RESCHEDULE_PENDING externalId=${maskExternalId(
        String(input.externalId),
      )} calendarId=${maskExternalId(String(matchedEntry.calendarId))} mode=${input.schedulingMode}`,
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
    if ((await this.getPendingState(externalId)) === 'expired') {
      return {
        confirmed: false,
        message: RESCHEDULE_EXPIRED_MESSAGE,
      };
    }
    const pending = await this.store.takeValid(externalId, userId, {
      ...binding,
      ...(approvalToken ? { nonce: approvalToken } : {}),
    });
    if (!pending) {
      const state = await this.getPendingState(externalId);
      if (state === 'expired') {
        return {
          confirmed: false,
          message: RESCHEDULE_EXPIRED_MESSAGE,
        };
      }
      if (state === 'processing') {
        return {
          confirmed: false,
          message: RESCHEDULE_IN_PROGRESS_MESSAGE,
        };
      }
      return {
        confirmed: false,
        message:
          'Không còn yêu cầu đổi lịch đang chờ xác nhận. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }
    const leaseToken = pending.leaseToken;
    if (!leaseToken) {
      return {
        confirmed: false,
        message:
          'Không thể xác thực yêu cầu đổi lịch này. Bạn nhắn lại nhu cầu đổi lịch nhé.',
      };
    }

    if (
      this.store.requiresApprovalToken &&
      (pending.toolName !== 'reschedule_study_session' ||
        !pending.intentHash ||
        !pending.argsHash ||
        !pending.nonce)
    ) {
      await this.store.revertToPending(externalId, leaseToken);
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
        await this.store.revertToPending(externalId, leaseToken);
        this.logger.log(
          `RESCHEDULE_BUDGET_EXCEEDED externalId=${maskExternalId(String(externalId))}`,
        );
        return {
          confirmed: false,
          message:
            this.options.rescheduleBudgetExceededMessage ??
            RESCHEDULE_UNAVAILABLE_MESSAGE,
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

      await this.store.cancelClaimed(externalId, leaseToken);

      await this.runCalendarCacheInvalidation(externalId);

      this.logger.log(
        `RESCHEDULE_CONFIRMED externalId=${maskExternalId(
          String(externalId),
        )} calendarId=${maskExternalId(String(pending.calendarId))}`,
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
      if (error instanceof RescheduleScopeError) {
        await this.store.cancelClaimed(externalId, leaseToken);
        this.recordScopeFailure(externalId, error.reason, pending.calendarId);
        return {
          confirmed: false,
          message: RESCHEDULE_SCOPE_ERROR_MESSAGE,
        };
      }
      const message = errorMessage(error);
      this.logger.warn(
        `RESCHEDULE_CONFIRM_FAILED externalId=${maskExternalId(
          String(externalId),
        )}: ${sanitizeLogValue(message, 500)}`,
      );
      // Keep the confirmation pending so the user can tap confirm again —
      // a transient Wispace failure must not burn the staged request.
      await this.store.revertToPending(externalId, leaseToken);
      return {
        confirmed: false,
        message: RESCHEDULE_UNAVAILABLE_MESSAGE,
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
      return RESCHEDULE_INVALID_TOKEN_MESSAGE;
    }
    const outcome = await this.cancelForUser(externalId, approvalToken);
    switch (outcome) {
      case 'cancelled':
        return RESCHEDULE_CANCELLED_MESSAGE;
      case 'processing':
        return RESCHEDULE_CANCEL_PROCESSING_MESSAGE;
      case 'expired':
        return RESCHEDULE_EXPIRED_MESSAGE;
      default:
        return RESCHEDULE_CANCEL_NONE_MESSAGE;
    }
  }

  async cancelForUser(
    externalId: TExternalId,
    approvalToken?: string,
  ): Promise<RescheduleCancellationOutcome> {
    if (
      this.store.requiresApprovalToken &&
      approvalToken !== undefined &&
      !isValidApprovalToken(approvalToken)
    ) {
      return 'none';
    }
    const state = await this.getPendingState(externalId);
    if (state === 'expired') {
      return 'expired';
    }
    const outcome = await this.cancelPendingOnce(externalId, approvalToken);
    if (outcome === 'cancelled') {
      this.logger.log(
        `RESCHEDULE_CANCELLED externalId=${maskExternalId(String(externalId))}`,
      );
    }
    return outcome;
  }

  /** Removes only the staged request owned by the optional nonce. */
  async cancelPending(externalId: TExternalId, nonce?: string): Promise<void> {
    try {
      await this.cancelPendingOnce(externalId, nonce);
      return;
    } catch {
      try {
        await this.cancelPendingOnce(externalId, nonce);
        return;
      } catch (error) {
        this.logger.warn(
          `RESCHEDULE_ABORT_CLEANUP_FAILED externalId=${maskExternalId(
            String(externalId),
          )}: ${sanitizeLogValue(errorMessage(error), 200)}`,
        );
      }
    }
  }

  /** Current proposal state, with expiry removed on the first related read. */
  async getPendingState(
    externalId: TExternalId,
  ): Promise<ReschedulePendingState> {
    if (this.store.getPendingState) {
      return this.store.getPendingState(externalId);
    }
    return (await this.store.hasPending(externalId)) ? 'pending' : 'none';
  }

  /** Whether a valid (unexpired) pending reschedule exists for this user. */
  hasPending(externalId: TExternalId): Promise<boolean> {
    return this.getPendingState(externalId).then(
      (state) => state === 'pending',
    );
  }

  private cancelPendingOnce(
    externalId: TExternalId,
    nonce?: string,
  ): Promise<RescheduleCancellationOutcome> {
    return nonce === undefined
      ? this.store.cancelPending(externalId)
      : this.store.cancelPending(externalId, nonce);
  }

  private async runCalendarCacheInvalidation(
    externalId: TExternalId,
  ): Promise<void> {
    const invalidation = this.options.calendarCacheInvalidation;
    if (!invalidation) {
      return;
    }
    try {
      await invalidation.invalidateCalendar(externalId);
    } catch (error) {
      this.logger.warn(
        `RESCHEDULE_CALENDAR_CACHE_INVALIDATION_FAILED externalId=${maskExternalId(
          String(externalId),
        )}: ${sanitizeLogValue(errorMessage(error), 200)}`,
      );
    }
  }

  private recordScopeFailure(
    externalId: TExternalId,
    reason: RescheduleScopeFailureReason,
    calendarId?: number,
    ownerUserId?: number,
  ): void {
    this.options.scopeFailureInc?.(reason);
    this.logger.warn(
      `RESCHEDULE_SCOPE_BLOCKED externalId=${maskExternalId(String(externalId))}${
        calendarId === undefined
          ? ''
          : ` calendarId=${maskExternalId(String(calendarId))}`
      }${
        ownerUserId === undefined
          ? ''
          : ` ownerUserId=${maskExternalId(String(ownerUserId))}`
      } reason=${reason}`,
    );
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
