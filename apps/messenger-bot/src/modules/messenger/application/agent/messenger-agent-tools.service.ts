import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import type {
  PlatformAgentReply,
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
  CurrentPlatformIdentity,
} from '@wispace/chat-agent';
import { RESCHEDULE_SCOPE_ERROR_MESSAGE } from '@wispace/reschedule-confirm';
import {
  executePrecreateExerciseTool,
  isWriteToolName,
  refundConsumedWriteToolBudget,
  runWriteToolBudgetGate,
  type WriteToolBudgetPort,
} from '@wispace/chat-agent';
import {
  isAgentToolName,
  parseAndValidateToolArguments,
  sanitizeUntrustedTextForLlm,
  type AgentToolName,
} from '@wispace/llm-agent';
import {
  readCalendarTimeRange,
  readPastDays,
  readPositiveInteger,
  readPositiveLimit,
  readSchedulingMode,
  readValidatedDate,
  readValidatedTime,
} from '@wispace/llm-agent';
import {
  MessengerLinkContext,
  getPocAlreadySubscribedMessage,
  getPocSubscriptionConfirmationMessage,
  parseMessengerLinkContext,
} from '@messenger/shared/config/poc.constants';
import {
  getNoUpcomingStudySessionMessage,
  getStudyReminderLeadTimeNotice,
} from '@messenger/modules/study-reminder/application/messages/study-reminder.messages';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import { MessengerMappingService } from '../services/messenger-mapping.service';
import { STUDY_REMINDER_OPERATIONS_PORT } from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';
import type { StudyReminderOperationsPort } from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';
import { MemoizedWispaceGoalsService } from '@wispace/wispace-client';
import { StudentReportService } from '../../../student-report/application/services/student-report.service';
import {
  buildCalendarEntriesRichFollowUp,
  buildReminderPreviewRichFollowUp,
  buildStudySessionsRichFollowUps,
  buildUserGoalsRichFollowUp,
} from '../formatters/messenger-rich-message.builder';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import { sanitizeMessengerText } from '@messenger/shared/utils/messenger-text.utils';
import {
  hasExplicitRescheduleTarget,
  isRescheduleIntent,
} from '@messenger/shared/utils/messenger-chat-intent.utils';
import { MessengerRescheduleConfirmationService } from '../services/messenger-reschedule-confirmation.service';
import { withTimeout } from '@messenger/shared/utils/promise-timeout.utils';
import { PrecreateExerciseApiClient } from '@wispace/wispace-client';
import { hasMessengerReportSubscriptionIntent } from '@messenger/shared/utils/messenger-report-subscription-intent.utils';

export const MESSENGER_NOT_LINKED_MESSAGE =
  'Chưa liên kết tài khoản WISPACE. Học viên cần mở Messenger từ link trong app WISPACE.';
export const MESSENGER_TOOL_IDENTITY_PROVIDER = Symbol(
  'MESSENGER_TOOL_IDENTITY_PROVIDER',
);
export const MESSENGER_TOOL_POLICY_DENIED_INC = Symbol(
  'MESSENGER_TOOL_POLICY_DENIED_INC',
);
export const MESSENGER_WRITE_TOOL_BUDGET = Symbol(
  'MESSENGER_WRITE_TOOL_BUDGET',
);
export const MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS = Symbol(
  'MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS',
);
export const MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC = Symbol(
  'MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC',
);
const REPORT_SUBSCRIPTION_INTENT_UNCLEAR_RESULT = {
  registered: false,
  reason: 'intent_unclear',
  message: 'Bạn muốn đăng ký nhận báo cáo tự động đúng không?',
} as const;

/**
 * Messenger's app-owned tool executor — implements `PlatformToolExecutorPort`
 * because every WISPACE tool here uses Messenger data sources (LLM report,
 * StudyReminderOperationsPort, real subscription upsert) and pushes Messenger
 * quick-reply follow-ups. Explicit app adapter, not a conditional dispatcher.
 */
@Injectable()
export class MessengerAgentToolsService implements PlatformToolExecutorPort {
  private readonly logger = new Logger(MessengerAgentToolsService.name);

  constructor(
    @Inject(MESSENGER_REPOSITORY)
    private readonly repository: MessengerMappingRepositoryPort,
    private readonly studentReportService: StudentReportService,
    private readonly memoizedGoals: MemoizedWispaceGoalsService,
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly studyPort: StudyReminderOperationsPort,
    private readonly rescheduleConfirmationService: MessengerRescheduleConfirmationService,
    private readonly exerciseClient: PrecreateExerciseApiClient,
    private readonly mappingService: MessengerMappingService,
    @Optional()
    @Inject(MESSENGER_TOOL_IDENTITY_PROVIDER)
    private readonly currentIdentityProvider?: (
      externalUserId: string,
    ) => Promise<CurrentPlatformIdentity | undefined>,
    @Optional()
    @Inject(MESSENGER_TOOL_POLICY_DENIED_INC)
    private readonly policyDeniedInc?: (
      toolName: string,
      reason: string,
    ) => void,
    @Optional()
    @Inject(MESSENGER_WRITE_TOOL_BUDGET)
    private readonly writeToolBudget?: WriteToolBudgetPort,
    @Optional()
    @Inject(MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS)
    private readonly writeToolPerMessageCaps?: Record<string, number>,
    @Optional()
    @Inject(MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC)
    private readonly writeToolBudgetDeniedInc?: (
      tool: string,
      reason: 'per_message',
    ) => void,
  ) {}

  async execute(
    toolName: string,
    argsJson: string,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!isAgentToolName(toolName)) {
      return { error: `Unknown tool: ${toolName}` };
    }

    const parsed = parseAndValidateToolArguments(toolName, argsJson, {
      allowMissingRequired: true,
    });
    if (!parsed.ok) {
      this.policyDeniedInc?.(toolName, 'invalid_arguments');
      return { error: parsed.error };
    }

    if (!this.currentIdentityProvider) {
      this.policyDeniedInc?.(toolName, 'missing_identity_provider');
      return { available: false, message: MESSENGER_NOT_LINKED_MESSAGE };
    }

    if (this.currentIdentityProvider) {
      try {
        const identity = await this.currentIdentityProvider(ctx.externalUserId);
        if (
          !identity ||
          !Number.isInteger(identity.userId) ||
          identity.userId <= 0 ||
          typeof identity.mappingVersion !== 'string' ||
          !identity.mappingVersion.trim()
        ) {
          this.policyDeniedInc?.(toolName, 'missing_mapping');
          return { available: false, message: MESSENGER_NOT_LINKED_MESSAGE };
        }
        ctx.userId = identity.userId;
        ctx.mappingVersion = identity.mappingVersion;
      } catch (error) {
        const safeError = this.safeErrorMessage(error, ctx.externalUserId);
        this.logger.warn(
          `Current-mapping lookup failed for ${maskExternalId(ctx.externalUserId)}: ${safeError}`,
        );
        this.policyDeniedInc?.(toolName, 'mapping_lookup_failed');
        return { available: false, message: MESSENGER_NOT_LINKED_MESSAGE };
      }
    }

    if (isWriteToolName(toolName) && this.writeToolBudget && ctx.userId) {
      const denial = await runWriteToolBudgetGate(toolName, ctx, {
        budget: this.writeToolBudget,
        perMessageCaps: this.writeToolPerMessageCaps,
        deniedInc: this.writeToolBudgetDeniedInc,
      });
      if (denial) return denial;
    }

    try {
      return await this.dispatch(
        toolName,
        parsed.args,
        ctx,
        signal,
        parsed.canonicalArgs,
      );
    } catch (error) {
      const safeError = this.safeErrorMessage(error, ctx.externalUserId);
      this.logger.warn(
        `Tool ${toolName} failed for externalUserId=${maskExternalId(
          ctx.externalUserId,
        )}: ${safeError}`,
      );
      return {
        error: safeError,
      };
    }
  }

  private safeErrorMessage(error: unknown, externalUserId: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(errorMessage(error), {
      maxChars: 500,
      unsafePlaceholder: 'Tool execution failed',
    }).text;
    return maskExternalIdInText(sanitized, externalUserId);
  }

  private async dispatch(
    toolName: AgentToolName,
    args: Record<string, unknown>,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
    canonicalArgs?: string,
  ): Promise<unknown> {
    // Tool execution timed out (agent moved on) — do not start new side effects.
    if (signal?.aborted) {
      return { error: 'Tool execution aborted (timeout)' };
    }

    switch (toolName) {
      case 'get_learning_progress_report':
        return this.getLearningProgressReport(ctx.externalUserId, signal);
      case 'get_user_goals':
        return this.getUserGoals(ctx);
      case 'get_upcoming_study_sessions':
        return this.getUpcomingStudySessions(ctx, args);
      case 'list_study_calendar_entries':
        return this.listStudyCalendarEntries(ctx, args);
      case 'preview_next_study_reminder':
        return this.previewNextStudyReminder(ctx);
      case 'reschedule_study_session':
        return this.rescheduleStudySession(ctx, args, canonicalArgs);
      case 'register_exam_report_notifications':
        return this.registerExamReportNotifications(ctx);
      case 'precreate_next_exercise': {
        const precreateResult = await this.precreateNextExercise(ctx, signal);
        await refundConsumedWriteToolBudget(
          ctx,
          this.writeToolBudget,
          precreateResult,
        );
        return precreateResult;
      }
      default: {
        const unknownTool = toolName as string;
        return { error: `Unhandled tool: ${unknownTool}` };
      }
    }
  }

  private async getUserGoals(ctx: PlatformAgentToolContext): Promise<unknown> {
    const goals = await this.memoizedGoals.getUserGoals(ctx.externalUserId);
    this.pushRichFollowUp(ctx, buildUserGoalsRichFollowUp(goals));
    return goals;
  }

  async tryFastDefaultReschedule(
    ctx: PlatformAgentToolContext,
    userText: string,
  ): Promise<PlatformAgentReply | null> {
    if (!ctx.userId || !isRescheduleIntent(userText)) {
      return null;
    }

    if (hasExplicitRescheduleTarget(userText)) {
      return null;
    }

    const list = await this.studyPort.listEntries(
      ctx.externalUserId,
      ctx.userId,
      { timeRange: 'upcoming' },
    );

    if (list.entries.length !== 1) {
      return null;
    }

    const entry = list.entries[0];

    const staged = await this.rescheduleConfirmationService.stage({
      externalId: ctx.externalUserId,
      userId: ctx.userId,
      calendarId: entry.calendarId,
      schedulingMode: 'default_next_day_same_time',
      platform: 'messenger',
      mappingVersion: ctx.mappingVersion,
      intent: userText,
      canonicalArgs: JSON.stringify({
        calendarId: entry.calendarId,
        schedulingMode: 'default_next_day_same_time',
        newLocalDate: null,
        newTime: null,
      }),
    });

    if ('error' in staged) {
      return null;
    }

    const minutesBefore = this.studyPort.getOutboxSettings().minutesBefore;

    return {
      text: sanitizeMessengerText(
        [
          'Mình đã chuẩn bị đổi lịch theo yêu cầu của bạn.',
          'Bấm «Xác nhận đổi lịch» bên dưới để hoàn tất — nếu không muốn đổi nữa thì bấm Hủy nhé.',
          getStudyReminderLeadTimeNotice(minutesBefore),
        ].join('\n\n'),
      ),
      richFollowUps: [staged.richFollowUp],
      privateDataFetched: false,
    };
  }

  private async getLearningProgressReport(
    psid: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const cached = this.studentReportService.getCachedReport(psid);
    const report =
      cached ??
      (await withTimeout(
        this.studentReportService.generateReportStatic(psid, signal),
        15_000,
        `Tool get_learning_progress_report`,
      ));
    return { report };
  }

  private async precreateNextExercise(
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executePrecreateExerciseTool(
      ctx,
      // Messenger bakes its platform identity header at the app boundary (#425).
      {
        precreateNextExercise: (externalId, options) =>
          this.exerciseClient.precreateNextExercise(
            'x-psid',
            externalId,
            options,
          ),
      },
      {
        getNotLinkedMessage: () => MESSENGER_NOT_LINKED_MESSAGE,
        logger: this.logger,
      },
      signal,
    );
  }

  private async listStudyCalendarEntries(
    ctx: PlatformAgentToolContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const timeRange = readCalendarTimeRange(args.timeRange) ?? 'upcoming';
    const list = await this.studyPort.listEntries(
      ctx.externalUserId,
      ctx.userId,
      {
        timeRange,
        limit: readPositiveLimit(args.limit, 10),
        pastDays: readPastDays(args.pastDays),
      },
    );
    const entries = list.entries.map(
      ({ ownerUserId: _ownerUserId, ...entry }) => entry,
    );
    this.pushRichFollowUp(ctx, buildCalendarEntriesRichFollowUp(entries));
    const minutesBefore = this.studyPort.getOutboxSettings().minutesBefore;

    return {
      ...list,
      entries,
      reminderNotice:
        list.timeRange === 'upcoming' && entries.length > 0
          ? getStudyReminderLeadTimeNotice(minutesBefore)
          : undefined,
    };
  }

  private async getUpcomingStudySessions(
    ctx: PlatformAgentToolContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const limit = readPositiveLimit(args.limit, 5);
    const sessions = await this.studyPort.getUpcomingSessions({
      psid: ctx.externalUserId,
      userId: ctx.userId,
    });

    const mapped = sessions.slice(0, limit).map((session) => ({
      sessionKey: session.sessionKey,
      topic: session.topic,
      scheduledAtIso: session.scheduledAt.toISOString(),
      scheduledTimeLabel: this.studyPort.formatScheduledTimeLabel(
        session.scheduledAt,
      ),
    }));

    this.pushRichFollowUp(ctx, ...buildStudySessionsRichFollowUps(mapped));

    const minutesBefore = this.studyPort.getOutboxSettings().minutesBefore;

    return {
      count: sessions.length,
      sessions: mapped,
      reminderNotice:
        mapped.length > 0
          ? getStudyReminderLeadTimeNotice(minutesBefore)
          : undefined,
    };
  }

  private async previewNextStudyReminder(
    ctx: PlatformAgentToolContext,
  ): Promise<unknown> {
    const session = await this.studyPort.getNextUpcomingSession(
      ctx.externalUserId,
      ctx.userId,
    );

    if (!session) {
      return {
        hasSession: false,
        message: getNoUpcomingStudySessionMessage(
          this.studyPort.getOutboxSettings().minutesBefore,
        ),
      };
    }

    const bundle = await this.studyPort.generateReminderBundleForSession(
      ctx.externalUserId,
      session,
      { userId: ctx.userId },
    );

    const scheduledTimeLabel = this.studyPort.formatScheduledTimeLabel(
      session.scheduledAt,
    );

    const teaser = [bundle.output.greeting, bundle.output.intro]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');

    this.pushRichFollowUp(
      ctx,
      buildReminderPreviewRichFollowUp({ scheduledTimeLabel, teaser }),
    );

    return {
      hasSession: true,
      scheduledTimeLabel,
      reminder: bundle.text,
    };
  }

  private async rescheduleStudySession(
    ctx: PlatformAgentToolContext,
    args: Record<string, unknown>,
    canonicalArgs?: string,
  ): Promise<unknown> {
    if (ctx.userText !== undefined && !isRescheduleIntent(ctx.userText)) {
      return { error: 'intent_unclear' };
    }
    if (!ctx.userId) {
      return {
        rescheduled: false,
        message: MESSENGER_NOT_LINKED_MESSAGE,
      };
    }

    const calendarId = readPositiveInteger(args.calendarId);
    if (!calendarId) {
      return { error: 'calendarId is required' };
    }

    const schedulingMode = readSchedulingMode(args.schedulingMode);
    if (!schedulingMode) {
      return {
        error: 'schedulingMode must be default_next_day_same_time or explicit',
      };
    }

    const upcoming = await this.studyPort.listEntries(
      ctx.externalUserId,
      ctx.userId,
      { timeRange: 'upcoming' },
    );
    const matchedEntry = upcoming.entries.find(
      (entry) => entry.calendarId === calendarId,
    );
    if (!matchedEntry) {
      this.policyDeniedInc?.('reschedule_study_session', 'scope_unverified');
      this.logger.warn(
        `Reschedule scope could not be verified for ${maskExternalId(
          ctx.externalUserId,
        )} calendarId=${maskExternalId(String(calendarId))}`,
      );
      return { error: RESCHEDULE_SCOPE_ERROR_MESSAGE };
    }

    const newLocalDate = readValidatedDate(args.newLocalDate);
    const newTime = readValidatedTime(args.newTime);

    if (
      args.newLocalDate !== undefined &&
      args.newLocalDate !== null &&
      !newLocalDate
    ) {
      return { error: 'newLocalDate must be in YYYY-MM-DD format' };
    }

    if (args.newTime !== undefined && args.newTime !== null && !newTime) {
      return { error: 'newTime must be in HH:MM format' };
    }

    const staged = await this.rescheduleConfirmationService.stage({
      externalId: ctx.externalUserId,
      userId: ctx.userId,
      calendarId: matchedEntry.calendarId,
      schedulingMode,
      newLocalDate,
      newTime,
      platform: 'messenger',
      mappingVersion: ctx.mappingVersion,
      intent: ctx.userText,
      canonicalArgs,
    });

    if ('error' in staged) {
      return staged;
    }

    this.pushRichFollowUp(ctx, staged.richFollowUp);

    return {
      pendingConfirmation: true,
      sessionLabel: staged.sessionLabel,
      summary: staged.summary,
      message:
        'Đã gửi nút xác nhận. Chỉ đổi lịch sau khi học viên bấm «Xác nhận đổi lịch» trên Messenger.',
    };
  }

  private async registerExamReportNotifications(
    ctx: PlatformAgentToolContext,
  ): Promise<unknown> {
    if (!hasMessengerReportSubscriptionIntent(ctx.userText)) {
      return REPORT_SUBSCRIPTION_INTENT_UNCLEAR_RESULT;
    }

    const linkContext = await this.resolveLinkContext(ctx);
    if (!linkContext) {
      return {
        registered: false,
        message: MESSENGER_NOT_LINKED_MESSAGE,
      };
    }

    const existing = await this.repository.findActiveMappingByPsid(
      ctx.externalUserId,
    );
    if (
      existing?.cadence === linkContext.cadence &&
      existing?.topic === linkContext.topic
    ) {
      return {
        registered: true,
        alreadyActive: true,
        message: getPocAlreadySubscribedMessage(),
      };
    }

    const result = await this.mappingService.linkFromContext(
      ctx.externalUserId,
      linkContext,
      { notifyUser: false, syncStudyReminders: false },
    );

    if (result.blocked) {
      return { registered: false, blocked: true };
    }

    return {
      registered: true,
      alreadyActive: false,
      message: getPocSubscriptionConfirmationMessage(),
    };
  }

  private async resolveLinkContext(
    ctx: PlatformAgentToolContext,
  ): Promise<MessengerLinkContext | undefined> {
    if (ctx.linkContext) {
      return ctx.linkContext as MessengerLinkContext;
    }

    const mapping = await this.repository.findActiveMappingByPsid(
      ctx.externalUserId,
    );
    if (!mapping?.userId) {
      return undefined;
    }

    return parseMessengerLinkContext({
      ref: String(mapping.userId),
      topic: mapping.topic,
      cadence: mapping.cadence,
    });
  }

  private pushRichFollowUp(
    ctx: PlatformAgentToolContext,
    ...followUps: Array<MessengerRichFollowUp | undefined>
  ): void {
    for (const followUp of followUps) {
      if (followUp) {
        ctx.richFollowUps!.push(followUp);
      }
    }
  }
}
