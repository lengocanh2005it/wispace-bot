import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { maskExternalId } from '@wispace/bot-common';
import {
  StudentReportCore,
  type StudentReportPorts,
} from '@wispace/student-report';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { todayUsageDate } from '@wispace/chat-metering';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';
import { loadSystemPrompt } from '@messenger/shared/prompts/load-system-prompt';
import { sanitizeMessengerText } from '@messenger/shared/utils/messenger-text.utils';
import { LlmExecutionService } from '@messenger/modules/llm-execution/application/services/llm-execution.service';
import { LlmUsageRecorderService } from '@messenger/modules/llm-usage/application/services/llm-usage-recorder.service';
import { TaskScoreAverageApiService } from '../../infrastructure/wispace/task-score-average-api.service';

/**
 * Thin NestJS adapter around the platform-agnostic `@wispace/student-report`
 * core (capacity fetch → LLM call → fallback → format). Owns: Messenger-
 * specific ports (LLM execution/usage wiring), system prompt loading, and
 * Messenger text sanitization (Markdown stripping).
 */
@Injectable()
export class StudentReportService {
  private readonly logger = new Logger(StudentReportService.name);
  private core?: StudentReportCore;

  /**
   * Daily report cache (key `psid:YYYY-MM-DD`): the 08:00 cron, the menu
   * postback, and the chat tool all generate the same per-user daily report —
   * cache it so only one LLM call happens per user per day. Self-expiring via
   * date-keyed entries; no timers.
   */
  private readonly reportCache = new Map<
    string,
    { date: string; text: string }
  >();
  private static readonly CACHE_MAX_ENTRIES = 5_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly taskScoreAverageApi: TaskScoreAverageApiService,
    private readonly llmUsageRecorder: LlmUsageRecorderService,
    private readonly llmExecution: LlmExecutionService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {}

  generateReport(psid: string): Promise<string> {
    if (!this.core) {
      this.core = this.buildCore();
    }

    const timezone = resolveAppTimezone(this.configService);
    const correlationId = `${psid}:${todayUsageDate(timezone)}`;
    const cached = this.reportCache.get(correlationId);
    if (cached) {
      this.logger.debug(`Report cache hit psid=${maskExternalId(psid)}`);
      return Promise.resolve(cached.text);
    }

    return this.core.generateReport(psid, { correlationId }).then((text) => {
      this.reportCache.set(correlationId, {
        date: todayUsageDate(resolveAppTimezone(this.configService)),
        text,
      });
      this.evictStaleReports();
      return text;
    });
  }

  /** Cached AI report for today, or null — used by chat tools to avoid LLM calls. */
  getCachedReport(psid: string): string | null {
    const timezone = resolveAppTimezone(this.configService);
    return (
      this.reportCache.get(`${psid}:${todayUsageDate(timezone)}`)?.text ?? null
    );
  }

  /** Deterministic report — no LLM call. Chat-tool fallback when no cache. */
  generateReportStatic(psid: string, signal?: AbortSignal): Promise<string> {
    if (!this.core) {
      this.core = this.buildCore();
    }
    return this.core.generateReportStatic(psid, signal);
  }

  private evictStaleReports(): void {
    if (this.reportCache.size <= StudentReportService.CACHE_MAX_ENTRIES) {
      return;
    }
    const today = todayUsageDate(resolveAppTimezone(this.configService));
    for (const [key, entry] of this.reportCache) {
      if (this.reportCache.size <= StudentReportService.CACHE_MAX_ENTRIES) {
        break;
      }
      if (entry.date !== today) {
        this.reportCache.delete(key);
      }
    }
    while (this.reportCache.size > StudentReportService.CACHE_MAX_ENTRIES) {
      const oldestKey = this.reportCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.reportCache.delete(oldestKey);
    }
  }

  private buildCore(): StudentReportCore {
    const ports: StudentReportPorts = {
      llmExecution: {
        run: (fn, meta) => this.llmExecution.run(fn, meta),
      },
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.llmUsageRecorder.recordFromCompletion({
            feature: 'STUDENT_REPORT',
            psid: params.externalUserId,
            model: params.model,
            response: params.response as Parameters<
              LlmUsageRecorderService['recordFromCompletion']
            >[0]['response'],
            correlationId: params.correlationId,
          }),
      },
      capacityData: {
        getCapacityData: (psid) =>
          this.taskScoreAverageApi.getCapacityData(psid),
      },
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    };

    return new StudentReportCore(
      {
        adapter: this.adapter,
        systemPrompt: loadSystemPrompt('studentReport'),
        sanitizeText: sanitizeMessengerText,
      },
      ports,
    );
  }
}
