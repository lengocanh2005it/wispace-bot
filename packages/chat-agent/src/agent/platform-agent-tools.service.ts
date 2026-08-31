import { Injectable, Logger } from '@nestjs/common';
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
  parseAndValidateToolArguments,
  getAgentToolDefinition,
  detectPromptInjection,
  sanitizeUntrustedTextForLlm,
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from '@wispace/llm-agent';
import { isWriteToolName, type WriteToolName } from './write-tool-budget';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
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

  constructor(
    private readonly goalsPort: GoalsCapabilityPort,
    private readonly calendarPort: CalendarCapabilityPort,
    private readonly stagePort: RescheduleStagePort,
    private readonly options: PlatformAgentToolsOptions,
    private readonly exercisePort?: ExerciseCapabilityPort,
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
      this.options.policyDeniedInc?.(toolName, 'invalid_arguments');
      return { error: parsed.error };
    }

    const capability = getAgentToolDefinition(toolName)?.capability;
    if (!capability) {
      this.options.policyDeniedInc?.(toolName, 'missing_capability');
      return { error: 'Tool execution blocked by policy' };
    }

    if (
      ctx.userText !== undefined &&
      capability.confirmation !== 'none' &&
      toolName !== 'precreate_next_exercise' &&
      !this.hasExplicitIntent(toolName, ctx.userText)
    ) {
      this.options.policyDeniedInc?.(toolName, 'intent_unclear');
      return { error: 'intent_unclear' };
    }

    if (capability.identity === 'linked_wispace_account') {
      const identity = await this.resolveCurrentIdentity(ctx, toolName);
      if (!identity) {
        return {
          available: false,
          message: this.options.getNotLinkedMessage(),
        };
      }
      ctx.userId = identity.userId;
      ctx.mappingVersion = identity.mappingVersion;
    }

    if (
      isWriteToolName(toolName) &&
      this.options.writeToolBudget &&
      ctx.userId
    ) {
      const denial = await this.enforceWriteToolBudget(toolName, ctx);
      if (denial) return denial;
    }

    try {
      return await this.dispatch(toolName, parsed.args, ctx, signal);
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

  private async enforceWriteToolBudget(
    toolName: WriteToolName,
    ctx: PlatformAgentToolContext,
  ): Promise<{ status: 'budget_exceeded'; messageHint: string } | undefined> {
    const budget = this.options.writeToolBudget!;
    const userId = ctx.userId!;

    const perMessageCap = this.options.writeToolPerMessageCaps?.[toolName];
    if (perMessageCap !== undefined) {
      ctx.writeToolCalls ??= new Map();
      const soFar = ctx.writeToolCalls.get(toolName) ?? 0;
      if (soFar >= perMessageCap) {
        this.options.writeToolBudgetDeniedInc?.(toolName, 'per_message');
        return {
          status: 'budget_exceeded',
          messageHint: buildWriteToolPerMessageBudgetMessage(
            toolName,
            perMessageCap,
          ),
        };
      }
      ctx.writeToolCalls.set(toolName, soFar + 1);
    }

    if (toolName === 'reschedule_study_session') {
      const allowed = await budget.checkDailyAllowed(
        ctx.externalUserId,
        userId,
        toolName,
      );
      if (!allowed) {
        return {
          status: 'budget_exceeded',
          messageHint: buildWriteToolDailyBudgetMessage(toolName),
        };
      }
      return undefined;
    }

    const consumed = await budget.consumeDaily(
      ctx.externalUserId,
      userId,
      toolName,
    );
    if (!consumed) {
      return {
        status: 'budget_exceeded',
        messageHint: buildWriteToolDailyBudgetMessage(toolName),
      };
    }
    ctx.writeToolDailyConsumed ??= new Set();
    ctx.writeToolDailyConsumed.add(toolName);
    return undefined;
  }

  private async refundPrecreateBudgetIfNeeded(
    ctx: PlatformAgentToolContext,
    result: unknown,
  ): Promise<void> {
    if (!ctx.writeToolDailyConsumed?.has('precreate_next_exercise')) return;
    const created =
      !!result &&
      typeof result === 'object' &&
      (result as { status?: unknown }).status === 'created';
    if (created) return;
    await this.options.writeToolBudget?.refundDaily(
      ctx.userId!,
      'precreate_next_exercise',
    );
    ctx.writeToolDailyConsumed.delete('precreate_next_exercise');
  }

  private hasExplicitIntent(
    toolName: AgentToolName,
    userText: string,
  ): boolean {
    const text = userText.trim().toLowerCase();
    if (!text) return false;
    if (detectPromptInjection(text).isInjection) return false;
    if (toolName === 'reschedule_study_session') {
      return (
        /(đổi|dời|chuyển|hoãn|reschedule|move|change)/i.test(text) &&
        /(lịch|buổi\s*học|giờ\s*học|schedule)/i.test(text)
      );
    }
    if (toolName === 'register_exam_report_notifications') {
      return /(đăng\s*ký|register).*(báo\s*cáo|report)|(báo\s*cáo|report).*(tự\s*động|automatic)/i.test(
        text,
      );
    }
    // precreate_next_exercise applies its stricter injection/selection gate
    // in executePrecreateExerciseTool; this preliminary check only rejects a
    // plainly unrelated message.
    return toolName === 'precreate_next_exercise';
  }

  private async resolveCurrentIdentity(
    ctx: PlatformAgentToolContext,
    toolName: AgentToolName,
  ): Promise<{ userId: number; mappingVersion: string } | undefined> {
    const provider = this.options.currentIdentityProvider;
    if (typeof provider !== 'function') {
      this.options.policyDeniedInc?.(toolName, 'missing_identity_provider');
      return undefined;
    }
    try {
      const identity = await provider(ctx.externalUserId);
      if (
        !identity ||
        !Number.isInteger(identity.userId) ||
        identity.userId <= 0 ||
        typeof identity.mappingVersion !== 'string' ||
        !identity.mappingVersion.trim()
      ) {
        this.options.policyDeniedInc?.(toolName, 'missing_mapping');
        return undefined;
      }
      return identity;
    } catch (error) {
      const safeError = this.safeErrorMessage(error, ctx.externalUserId);
      this.logger.warn(
        `Current-mapping lookup failed for ${maskExternalId(ctx.externalUserId)}: ${safeError}`,
      );
      this.options.policyDeniedInc?.(toolName, 'mapping_lookup_failed');
      return undefined;
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
  ): Promise<unknown> {
    // Tool execution timed out (agent moved on) — do not start new side effects.
    if (signal?.aborted) {
      return { error: 'Tool execution aborted (timeout)' };
    }

    switch (toolName) {
      case 'get_user_goals':
        return this.withLinkedAccount(ctx, () => {
          ctx.privateDataFetched = true;
          return this.goalsPort.getUserGoals(
            this.options.wispaceExternalId(ctx),
            { signal },
          );
        });
      case 'get_learning_progress_report':
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
      case 'get_upcoming_study_sessions':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const limit = readPositiveLimit(args.limit, 5);
          const sessions = await this.calendarPort.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            { timeRange: 'upcoming', limit, signal },
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
          const sessions = await this.calendarPort.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            {
              timeRange,
              limit: readPositiveLimit(args.limit, 10),
              pastDays: readPastDays(args.pastDays),
              signal,
            },
          );
          return { timeRange, entries: this.mapSessions(sessions) };
        });
      case 'preview_next_study_reminder':
        return this.withLinkedAccount(ctx, async () => {
          ctx.privateDataFetched = true;
          const sessions = await this.calendarPort.getCalendarSessions(
            this.options.wispaceExternalId(ctx),
            { timeRange: 'upcoming', limit: 1, signal },
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
      case 'precreate_next_exercise': {
        const precreateResult = await executePrecreateExerciseTool(
          ctx,
          this.exercisePort,
          {
            getNotLinkedMessage: this.options.getNotLinkedMessage,
            logger: this.logger,
            cacheInvalidation: this.options.cacheInvalidation,
          },
          signal,
        );
        await this.refundPrecreateBudgetIfNeeded(ctx, precreateResult);
        return precreateResult;
      }
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
        const safeError = this.safeErrorMessage(error, ctx.externalUserId);
        this.logger.error(
          `Fresh-mapping query failed during reschedule for ${maskExternalId(ctx.externalUserId)}: ${safeError} — rejecting to prevent stale-identity staging`,
        );
        return { error: this.options.getNotLinkedMessage() };
      }
    }

    const stageInput = {
      externalId: ctx.externalUserId,
      userId: resolvedUserId,
      calendarId,
      schedulingMode,
      newLocalDate,
      newTime,
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

    if (staged.confirmationToken) {
      await this.options.reschedule.confirmSender(
        ctx.externalUserId,
        staged.summary,
        staged.confirmationToken,
      );
    } else {
      await this.options.reschedule.confirmSender(
        ctx.externalUserId,
        staged.summary,
      );
    }

    return {
      pendingConfirmation: true,
      sessionLabel: staged.sessionLabel,
    };
  }
}
