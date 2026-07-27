import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';
import { ZaloWispaceGoalsService } from '../../../wispace/application/services/zalo-wispace-goals.service';
import { ZaloWispaceCalendarService } from '../../../wispace/application/services/zalo-wispace-calendar.service';
import { ZaloRescheduleConfirmationService } from '../services/zalo-reschedule-confirmation.service';
import { ZaloOutboundService } from '../services/zalo-outbound.service';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Liên kết tài khoản để sử dụng tính năng này nhé.';

const NOT_AVAILABLE_MESSAGE =
  'Tính năng này chưa khả dụng trên Zalo — bạn dùng WISPACE qua Messenger cho việc này nhé.';

/**
 * Wires the WISPACE tools to real Wispace API calls once the Zalo
 * account is linked (`ctx.userId`).
 */
@Injectable()
export class ZaloAgentToolsService {
  private readonly logger = new Logger(ZaloAgentToolsService.name);
  private readonly oauthAuthorizeUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly goalsService: ZaloWispaceGoalsService,
    private readonly calendarService: ZaloWispaceCalendarService,
    private readonly rescheduleConfirmationService: ZaloRescheduleConfirmationService,
    private readonly outboundService: ZaloOutboundService,
  ) {
    const appId = this.configService.get<string>('ZALO_APP_ID');
    const redirectUri = this.configService.get<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );
    this.oauthAuthorizeUrl =
      appId && redirectUri
        ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
        : '';
  }

  async execute(
    toolName: string,
    argsJson: string,
    ctx: ZaloAgentToolContext,
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
        `Tool ${toolName} failed for zaloUserId=${ctx.zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        error: error instanceof Error ? error.message : 'Tool execution failed',
      };
    }
  }

  private async dispatch(
    toolName: AgentToolName,
    args: Record<string, unknown>,
    ctx: ZaloAgentToolContext,
  ): Promise<unknown> {
    switch (toolName) {
      case 'get_user_goals':
        return this.withLinkedAccount(ctx, () =>
          this.goalsService.getUserGoals(String(ctx.userId)),
        );
      case 'get_learning_progress_report':
        return this.withLinkedAccount(ctx, async () => {
          const [goals, taskScores] = await Promise.all([
            this.goalsService.getUserGoals(String(ctx.userId)),
            this.goalsService.getTaskScoreAverages(String(ctx.userId)),
          ]);
          return this.formatReport(goals, taskScores);
        });
      case 'get_upcoming_study_sessions':
        return this.withLinkedAccount(ctx, async () => {
          const limit = readPositiveLimit(args.limit, 5);
          const sessions = await this.calendarService.getCalendarSessions(
            String(ctx.userId),
            { timeRange: 'upcoming', limit },
          );
          return {
            count: sessions.length,
            sessions: this.mapSessions(sessions),
          };
        });
      case 'list_study_calendar_entries':
        return this.withLinkedAccount(ctx, async () => {
          const timeRange = readCalendarTimeRange(args.timeRange) ?? 'upcoming';
          const sessions = await this.calendarService.getCalendarSessions(
            String(ctx.userId),
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
          const sessions = await this.calendarService.getCalendarSessions(
            String(ctx.userId),
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
        return { available: false, message: NOT_AVAILABLE_MESSAGE };
      default: {
        const unknownTool = toolName as string;
        return { error: `Unhandled tool: ${unknownTool}` };
      }
    }
  }

  private withLinkedAccount(
    ctx: ZaloAgentToolContext,
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!ctx.userId) {
      const linkPart = this.oauthAuthorizeUrl
        ? `\n\nLiên kết tài khoản tại đây: ${this.oauthAuthorizeUrl}`
        : '';
      return Promise.resolve({
        available: false,
        message: `${NOT_LINKED_MESSAGE}${linkPart}`,
      });
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
    ctx: ZaloAgentToolContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const calendarId = readPositiveInteger(args.calendarId);
    if (!calendarId) {
      return { error: 'calendarId (số nguyên dương) là bắt buộc.' };
    }

    const schedulingMode = readSchedulingMode(args.schedulingMode);
    if (!schedulingMode) {
      return {
        error:
          'schedulingMode (default_next_day_same_time hoặc explicit) là bắt buộc.',
      };
    }

    const result = await this.rescheduleConfirmationService.stage({
      zaloUserId: ctx.zaloUserId,
      userId: ctx.userId!,
      calendarId,
      schedulingMode,
      newLocalDate: readValidatedDate(args.newLocalDate),
      newTime: readValidatedTime(args.newTime),
    });

    if ('error' in result) {
      return { error: result.error };
    }

    await this.outboundService.sendText(
      ctx.zaloUserId,
      `${result.summary}\n\nReply "xác nhận" để đồng ý, hoặc "hủy" để hủy.`,
    );

    return { pendingConfirmation: true, sessionLabel: result.sessionLabel };
  }
}
