import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  isAgentToolName,
  type AgentToolName,
  readPositiveLimit,
  readPastDays,
  readCalendarTimeRange,
  readPositiveInteger,
  readSchedulingMode,
  readValidatedDate,
  readValidatedTime,
} from '@wispace/llm-agent';
import {
  WispaceCalendarService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { errorMessage } from '@wispace/bot-common';
import type {
  PlatformAgentToolContext,
  PlatformAgentToolsOptions,
  RescheduleStagePort,
} from './platform-agent.types';

/**
 * Wires the WISPACE tools to real Wispace API calls once the platform
 * account is linked (`ctx.userId`). Platform-specific behavior (not-linked
 * message, Wispace external id, register-report message, reschedule
 * validation strings + confirmation mechanism) is injected per app — shared
 * by Discord and Zalo (replaces their near-identical per-app tools services).
 */
@Injectable()
export class PlatformAgentToolsService {
  private readonly logger = new Logger(PlatformAgentToolsService.name);

  constructor(
    // Messenger overrides every tool, so the shared Wispace services are
    // optional — Discord/Zalo always inject them.
    @Optional()
    private readonly goalsService: WispaceGoalsService | undefined,
    @Optional()
    private readonly calendarService: WispaceCalendarService | undefined,
    private readonly stagePort: RescheduleStagePort,
    private readonly options: PlatformAgentToolsOptions,
  ) {}

  async execute(
    toolName: string,
    argsJson: string,
    ctx: PlatformAgentToolContext,
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
      return await this.dispatch(toolName, args, ctx);
    } catch (error) {
      this.logger.warn(
        `Tool ${toolName} failed for externalUserId=${ctx.externalUserId}: ${errorMessage(error)}`,
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
  ): Promise<unknown> {
    const override = this.options.toolOverrides?.[toolName];
    if (override) {
      return override(ctx, args);
    }

    switch (toolName) {
      case 'get_user_goals':
        return this.withLinkedAccount(ctx, () => {
          ctx.privateDataFetched = true;
          return this.goalsService!.getUserGoals(
            this.options.wispaceExternalId(ctx),
          );
        });
      case 'get_learning_progress_report':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const [goals, taskScores] = await Promise.all([
            this.goalsService!.getUserGoals(
              this.options.wispaceExternalId(ctx),
            ),
            this.goalsService!.getTaskScoreAverages(
              this.options.wispaceExternalId(ctx),
            ),
          ]);
          return this.formatReport(goals, taskScores);
        });
      case 'get_upcoming_study_sessions':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const limit = readPositiveLimit(args.limit, 5);
          const sessions = await this.calendarService!.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            { timeRange: 'upcoming', limit },
          );
          return {
            count: sessions.length,
            sessions: this.mapSessions(sessions),
          };
        });
      case 'list_study_calendar_entries':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const timeRange = readCalendarTimeRange(args.timeRange) ?? 'upcoming';
          const sessions = await this.calendarService!.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            {
              timeRange,
              limit: readPositiveLimit(args.limit, 10),
              pastDays: readPastDays(args.pastDays),
            },
          );
          return { timeRange, entries: this.mapSessions(sessions) };
        });
      case 'preview_next_study_reminder':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const sessions = await this.calendarService!.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            { timeRange: 'upcoming', limit: 1 },
          );
          const session = sessions[0];
          return session
            ? { hasSession: true, session: this.mapSessions([session])[0] }
            : { hasSession: false };
        });
      case 'reschedule_study_session':
        return this.withLinkedAccount(ctx, () =>
          this.rescheduleStudySession(ctx, args),
        );
      case 'register_exam_report_notifications':
        // No side effect on Discord/Zalo: the report cron covers every linked
        // account, so registration is automatic. Be honest about it instead
        // of claiming a registration that never happened.
        return this.withLinkedAccount(ctx, () =>
          Promise.resolve({
            registered: false,
            alreadyActive: false,
            automatic: true,
            message: this.options.registerReportMessage,
          }),
        );
      default: {
        const unknownTool = toolName as string;
        return { error: `Unhandled tool: ${unknownTool}` };
      }
    }
  }

  private async withLinkedAccount(
    ctx: PlatformAgentToolContext,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!ctx.userId) {
      return { available: false, message: this.options.getNotLinkedMessage() };
    }

    return fn();
  }

  private mapSessions(
    sessions: Array<{ sessionKey: string; scheduledAt: Date; topic: string }>,
  ) {
    return sessions.map((session) => ({
      sessionKey: session.sessionKey,
      topic: session.topic,
      scheduledAtIso: session.scheduledAt.toISOString(),
    }));
  }

  private formatReport(
    goals: {
      targetBand?: string;
      examDate?: string;
      task1Band?: string;
      task2Band?: string;
    },
    taskScores: Array<{ task1Count?: number; task2Count?: number }> | null,
  ): string {
    const lines: string[] = ['📊 Báo cáo tiến độ IELTS Writing\n'];

    if (goals.targetBand) {
      lines.push(`🎯 Target band: ${goals.targetBand}`);
    }
    if (goals.examDate) {
      lines.push(`📅 Ngày thi: ${goals.examDate}`);
    }
    if (goals.task1Band) {
      lines.push(`📝 Task 1 band: ${goals.task1Band}`);
    }
    if (goals.task2Band) {
      lines.push(`📝 Task 2 band: ${goals.task2Band}`);
    }
    if (taskScores && taskScores.length > 0) {
      const score = taskScores[0];
      lines.push('');
      lines.push(`📝 Số bài Task 1: ${score.task1Count ?? 0}`);
      lines.push(`📝 Số bài Task 2: ${score.task2Count ?? 0}`);
    }

    return lines.join('\n');
  }

  private async rescheduleStudySession(
    ctx: PlatformAgentToolContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const calendarId = readPositiveInteger(args.calendarId);
    if (!calendarId) {
      return { error: this.options.reschedule.messages.calendarIdRequired };
    }

    const schedulingMode = readSchedulingMode(args.schedulingMode);
    if (!schedulingMode) {
      return {
        error: this.options.reschedule.messages.schedulingModeInvalid,
      };
    }

    const newLocalDate = readValidatedDate(args.newLocalDate);
    const newTime = readValidatedTime(args.newTime);

    if (this.options.reschedule.validateDateAndTime) {
      if (
        args.newLocalDate !== undefined &&
        args.newLocalDate !== null &&
        !newLocalDate
      ) {
        return {
          error: this.options.reschedule.messages.newLocalDateInvalid,
        };
      }

      if (args.newTime !== undefined && args.newTime !== null && !newTime) {
        return { error: this.options.reschedule.messages.newTimeInvalid };
      }
    }

    const staged = await this.stagePort.stage({
      externalId: ctx.externalUserId,
      userId: ctx.userId!,
      calendarId,
      schedulingMode,
      newLocalDate,
      newTime,
    });

    if ('error' in staged) {
      return staged;
    }

    await this.options.reschedule.confirmSender(
      ctx.externalUserId,
      staged.summary,
    );

    return {
      pendingConfirmation: true,
      sessionLabel: staged.sessionLabel,
    };
  }
}
