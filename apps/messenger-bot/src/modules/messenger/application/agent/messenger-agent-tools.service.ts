import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import type {
  PlatformAgentReply,
  PlatformAgentToolContext,
  PlatformToolExecutorPort,
} from '@wispace/chat-agent';
import { executePrecreateExerciseTool } from '@wispace/chat-agent';
import { isAgentToolName, type AgentToolName } from '@wispace/llm-agent';
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
import { UserGoalsApiService } from '../../../student-report/infrastructure/wispace/user-goals-api.service';
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
    private readonly userGoalsApiService: UserGoalsApiService,
    @Inject(STUDY_REMINDER_OPERATIONS_PORT)
    private readonly studyPort: StudyReminderOperationsPort,
    private readonly rescheduleConfirmationService: MessengerRescheduleConfirmationService,
    private readonly exerciseClient: PrecreateExerciseApiClient,
    private readonly mappingService: MessengerMappingService,
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

    let args: Record<string, unknown> = {};
    if (argsJson.trim()) {
      try {
        args = JSON.parse(argsJson) as Record<string, unknown>;
      } catch {
        return { error: 'Invalid tool arguments JSON' };
      }
    }

    try {
      return await this.dispatch(toolName, args, ctx, signal);
    } catch (error) {
      this.logger.warn(
        `Tool ${toolName} failed for externalUserId=${maskExternalId(
          ctx.externalUserId,
        )}: ${errorMessage(error)}`,
      );
      return {
        error: errorMessage(error),
      };
    }
  }

  private async dispatch(
    toolName: AgentToolName,
    args: Record<string, unknown>,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
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
        return this.rescheduleStudySession(ctx, args);
      case 'register_exam_report_notifications':
        return this.registerExamReportNotifications(ctx);
      case 'precreate_next_exercise':
        return this.precreateNextExercise(ctx, signal);
      default: {
        const unknownTool = toolName as string;
        return { error: `Unhandled tool: ${unknownTool}` };
      }
    }
  }

  private async getUserGoals(ctx: PlatformAgentToolContext): Promise<unknown> {
    const goals = await this.userGoalsApiService.getUserGoals(
      ctx.externalUserId,
    );
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
      this.exerciseClient,
      'x-psid',
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
    this.pushRichFollowUp(ctx, buildCalendarEntriesRichFollowUp(list.entries));
    const minutesBefore = this.studyPort.getOutboxSettings().minutesBefore;

    return {
      ...list,
      reminderNotice:
        list.timeRange === 'upcoming' && list.entries.length > 0
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
  ): Promise<unknown> {
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
      const options = upcoming.entries
        .map((entry) => `${entry.calendarId} (${entry.scheduledTimeLabel})`)
        .join(', ');
      return {
        error: `calendarId ${calendarId} không có trong lịch sắp tới. Dùng đúng id từ list_study_calendar_entries${options ? `: ${options}` : ''}.`,
      };
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
