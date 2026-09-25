import { Injectable, Logger } from '@nestjs/common';
import {
  type GetUpcomingStudySessionsArgs,
  type ListStudyCalendarEntriesArgs,
  type RescheduleStudySessionArgs,
  buildBoundedToolResultMetadata,
  readPositiveInteger,
  readPositiveLimit,
  readPastDays,
  readValidatedDate,
  readValidatedTime,
  sanitizeUntrustedTextForLlm,
} from '@wispace/llm-agent/core';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import {
  RESCHEDULE_INVALID_TOKEN_MESSAGE,
  RescheduleStageAbortedError,
} from '@wispace/reschedule-confirm';
import type {
  CalendarCapabilityPort,
  ExerciseCapabilityPort,
  GoalsCapabilityPort,
} from './wispace-capability.ports';
import type {
  PlatformAgentToolContext,
  PlatformAgentToolsOptions,
  PlatformToolExecutorPort,
  RescheduleStagePort,
} from './platform-agent.types';
import { executePrecreateExerciseTool } from './precreate-exercise-result';
import { PlatformToolExecutorPipeline } from './platform-tool-executor-pipeline';

/**
 * Shared WISPACE tool executor for the agent loop — implements the Discord
 * and Zalo tool sets (the platform-neutral behavior). WISPACE data access goes
 * through the capability ports (#425); each bot's composition root wires the
 * concrete wispace-client adapters. Messenger provides its own app-owned
 * executor via `PlatformToolExecutorPort`.
 */
@Injectable()
export class PlatformAgentToolsService implements PlatformToolExecutorPort {
  private readonly logger = new Logger(PlatformAgentToolsService.name);
  private readonly pipeline: PlatformToolExecutorPipeline;

  constructor(
    private readonly goalsPort: GoalsCapabilityPort,
    private readonly calendarPort: CalendarCapabilityPort,
    private readonly stagePort: RescheduleStagePort,
    private readonly options: PlatformAgentToolsOptions,
    private readonly exercisePort?: ExerciseCapabilityPort,
  ) {
    this.pipeline = new PlatformToolExecutorPipeline({
      handlers: {
        get_learning_progress_report: ({ ctx, signal }) =>
          this.getLearningProgressReport(ctx, signal),
        get_user_goals: ({ ctx, signal }) => this.getUserGoals(ctx, signal),
        get_upcoming_study_sessions: ({ args, requestedArgs, ctx, signal }) =>
          this.getUpcomingStudySessions(
            ctx,
            args as GetUpcomingStudySessionsArgs,
            requestedArgs,
            signal,
          ),
        list_study_calendar_entries: ({ args, requestedArgs, ctx, signal }) =>
          this.listStudyCalendarEntries(
            ctx,
            args as ListStudyCalendarEntriesArgs,
            requestedArgs,
            signal,
          ),
        preview_next_study_reminder: ({ ctx, signal }) =>
          this.previewNextStudyReminder(ctx, signal),
        reschedule_study_session: ({ args, ctx, signal }) =>
          this.rescheduleStudySession(
            ctx,
            args as Partial<RescheduleStudySessionArgs>,
            signal,
          ),
        register_exam_report_notifications: ({ ctx }) =>
          this.registerExamReportNotifications(ctx),
        precreate_next_exercise: ({ ctx, signal }) =>
          this.precreateNextExercise(ctx, signal),
      },
      getNotLinkedMessage: this.options.getNotLinkedMessage,
      currentIdentityProvider: this.options.currentIdentityProvider,
      policyDeniedInc: this.options.policyDeniedInc,
      writeToolBudget: this.options.writeToolBudget,
      writeToolPerMessageCaps: this.options.writeToolPerMessageCaps,
      writeToolBudgetDeniedInc: this.options.writeToolBudgetDeniedInc,
      logger: {
        warn: (message) => this.logger.warn(message),
      },
    });
  }

  async execute(
    toolName: string,
    argsJson: string,
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.pipeline.execute(toolName, argsJson, ctx, signal);
  }

  private safeErrorMessage(error: unknown, externalUserId: string): string {
    const sanitized = sanitizeUntrustedTextForLlm(errorMessage(error), {
      maxChars: 500,
      unsafePlaceholder: 'Tool execution failed',
    }).text;
    return maskExternalIdInText(sanitized, externalUserId);
  }

  private async getUserGoals(
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withLinkedAccount(ctx, () => {
      ctx.privateDataFetched = true;
      return this.goalsPort.getUserGoals(this.options.wispaceExternalId(ctx), {
        signal,
      });
    });
  }

  private async getLearningProgressReport(
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withLinkedAccount(ctx, async () => {
      ctx.privateDataFetched = true;
      const [goals, taskScores] = await Promise.all([
        this.goalsPort.getUserGoals(this.options.wispaceExternalId(ctx), {
          signal,
        }),
        this.goalsPort.getTaskScoreAverages(
          this.options.wispaceExternalId(ctx),
          { signal },
        ),
      ]);
      return this.formatReport(goals, taskScores);
    });
  }

  private async getUpcomingStudySessions(
    ctx: PlatformAgentToolContext,
    args: GetUpcomingStudySessionsArgs,
    requestedArgs?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withLinkedAccount(ctx, async () => {
      ctx.privateDataFetched = true;
      const sessionLimit = readPositiveLimit(args.limit, 5);
      const requestedLimit = readPositiveInteger(requestedArgs?.limit);
      const sessions = await this.calendarPort.getCalendarSessions(
        this.options.wispaceExternalId(ctx),
        {
          timeRange: 'upcoming',
          limit: sessionLimit,
          userId: ctx.userId,
          signal,
        },
      );
      const limitedSessions = sessions.slice(0, sessionLimit);
      return {
        timeRange: 'upcoming',
        count: limitedSessions.length,
        ...buildBoundedToolResultMetadata({
          requestedLimit,
          effectiveLimit: sessionLimit,
        }),
        sessions: this.mapSessions(limitedSessions),
      };
    });
  }

  private async listStudyCalendarEntries(
    ctx: PlatformAgentToolContext,
    args: ListStudyCalendarEntriesArgs,
    requestedArgs?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withLinkedAccount(ctx, async () => {
      ctx.privateDataFetched = true;
      const { timeRange = 'upcoming', limit, pastDays } = args;
      const requestedLimit = readPositiveInteger(requestedArgs?.limit);
      const requestedPastDays = readPositiveInteger(requestedArgs?.pastDays);
      const effectiveLimit = readPositiveLimit(limit, 10);
      const pastDaysApplies = timeRange === 'past' || timeRange === 'all';
      const effectivePastDays = pastDaysApplies
        ? readPastDays(pastDays)
        : undefined;
      const sessions = await this.calendarPort.getCalendarSessions(
        this.options.wispaceExternalId(ctx),
        {
          timeRange,
          limit: effectiveLimit,
          pastDays: effectivePastDays,
          userId: ctx.userId,
          signal,
        },
      );
      const limitedSessions = sessions.slice(0, effectiveLimit);
      return {
        timeRange,
        count: limitedSessions.length,
        ...buildBoundedToolResultMetadata({
          requestedLimit,
          effectiveLimit,
          ...(pastDaysApplies ? { requestedPastDays, effectivePastDays } : {}),
        }),
        entries: this.mapSessions(limitedSessions),
      };
    });
  }

  private async previewNextStudyReminder(
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.withLinkedAccount(ctx, async () => {
      ctx.privateDataFetched = true;
      const sessions = await this.calendarPort.getCalendarSessions(
        this.options.wispaceExternalId(ctx),
        { timeRange: 'upcoming', limit: 1, userId: ctx.userId, signal },
      );
      const session = sessions[0];
      return session
        ? { hasSession: true, session: this.mapSessions([session])[0] }
        : { hasSession: false };
    });
  }

  private async registerExamReportNotifications(
    ctx: PlatformAgentToolContext,
  ): Promise<unknown> {
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
  }

  private async precreateNextExercise(
    ctx: PlatformAgentToolContext,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return executePrecreateExerciseTool(
      ctx,
      this.exercisePort,
      {
        getNotLinkedMessage: this.options.getNotLinkedMessage,
        logger: this.logger,
        cacheInvalidation: this.options.cacheInvalidation,
      },
      signal,
    );
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
    args: Partial<RescheduleStudySessionArgs>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.throwIfAborted(signal);
    const calendarId = readPositiveInteger(args.calendarId);
    if (!calendarId) {
      return { error: this.options.reschedule.messages.calendarIdRequired };
    }

    const schedulingMode = args.schedulingMode;
    if (!schedulingMode) {
      return {
        error: this.options.reschedule.messages.schedulingModeInvalid,
      };
    }

    const newLocalDate = readValidatedDate(args.newLocalDate);
    const newTime = readValidatedTime(args.newTime);

    if (this.options.reschedule.validateDateAndTime) {
      if (args.newLocalDate !== undefined && !newLocalDate) {
        return {
          error: this.options.reschedule.messages.newLocalDateInvalid,
        };
      }

      if (args.newTime !== undefined && !newTime) {
        return { error: this.options.reschedule.messages.newTimeInvalid };
      }
    }

    // #397 defense-in-depth: re-verify the mapping before staging a
    // reschedule. This is the only tool with a destructive side-effect
    // (staging a session on a userId) — a stale identity here means
    // hijacking another user's calendar slot.
    let resolvedUserId = ctx.userId!;
    if (this.options.freshMappingProvider) {
      try {
        const freshMapping = await this.options.freshMappingProvider(
          ctx.externalUserId,
        );
        const freshUserId =
          typeof freshMapping === 'number'
            ? freshMapping
            : freshMapping?.state === 'active'
              ? freshMapping.userId
              : undefined;
        if (freshUserId === undefined) {
          this.logger.warn(
            `Reschedule blocked for ${maskExternalId(ctx.externalUserId)}: no active mapping${
              typeof freshMapping === 'object' && freshMapping
                ? ` (state=${freshMapping.state})`
                : ''
            }`,
          );
          return { error: this.options.getNotLinkedMessage() };
        }
        if (freshUserId !== resolvedUserId) {
          this.logger.warn(
            `Reschedule identity refresh for ${maskExternalId(ctx.externalUserId)}: userId ${maskExternalId(String(resolvedUserId))} → ${maskExternalId(String(freshUserId))}`,
          );
          resolvedUserId = freshUserId;
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          throw error;
        }
        const safeError = this.safeErrorMessage(error, ctx.externalUserId);
        this.logger.error(
          `Fresh-mapping query failed during reschedule for ${maskExternalId(ctx.externalUserId)}: ${safeError} — rejecting to prevent stale-identity staging`,
        );
        return { error: this.options.getNotLinkedMessage() };
      }
    }
    this.throwIfAborted(signal);

    const stageInput = {
      externalId: ctx.externalUserId,
      userId: resolvedUserId,
      calendarId,
      schedulingMode,
      newLocalDate,
      newTime,
      ...(signal ? { signal } : {}),
      ...(this.options.platform || ctx.mappingVersion || ctx.userText
        ? {
            platform: this.options.platform,
            mappingVersion: ctx.mappingVersion,
            intent: ctx.userText,
            canonicalArgs: JSON.stringify({
              calendarId,
              schedulingMode,
              newLocalDate: newLocalDate ?? null,
              newTime: newTime ?? null,
            }),
          }
        : {}),
    };
    const staged = await this.stagePort.stage(stageInput);

    if ('error' in staged) {
      return staged;
    }

    if (signal?.aborted) {
      if (staged.confirmationToken) {
        await this.cleanupStagedReschedule(
          ctx.externalUserId,
          staged.confirmationToken,
        );
      }
      throw new RescheduleStageAbortedError(signal.reason);
    }

    if (!staged.confirmationToken) {
      this.logger.error(
        `RESCHEDULE_STAGE_CONTRACT_VIOLATION externalUserId=${maskExternalId(
          ctx.externalUserId,
        )} missing approval token`,
      );
      return { error: RESCHEDULE_INVALID_TOKEN_MESSAGE };
    }

    this.throwIfAborted(signal);

    try {
      await this.options.reschedule.confirmSender(
        ctx.externalUserId,
        staged.summary,
        staged.confirmationToken,
        ctx.userId,
      );
    } catch (error) {
      if (staged.confirmationToken) {
        await this.cleanupStagedReschedule(
          ctx.externalUserId,
          staged.confirmationToken,
        );
      }
      throw error;
    }

    return {
      pendingConfirmation: true,
      sessionLabel: staged.sessionLabel,
    };
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new RescheduleStageAbortedError(signal.reason);
    }
  }

  private async cleanupStagedReschedule(
    externalUserId: string,
    confirmationToken: string,
  ): Promise<void> {
    try {
      await this.stagePort.cancelPending?.(externalUserId, confirmationToken);
    } catch (error) {
      this.logger.warn(
        `RESCHEDULE_ABORT_CLEANUP_FAILED externalUserId=${maskExternalId(
          externalUserId,
        )}: ${this.safeErrorMessage(error, externalUserId)}`,
      );
    }
  }
}
