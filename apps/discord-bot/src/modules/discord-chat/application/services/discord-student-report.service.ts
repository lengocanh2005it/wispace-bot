import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import {
  StudentReportCore,
  type StudentReportPorts,
  type StudentCapacityInput,
} from '@wispace/student-report';
import { retryWithBackoff, type LlmProviderAdapter } from '@wispace/llm-agent';
import {
  PlatformLlmUsageRecorderAdapter,
  todayUsageDate,
} from '@wispace/chat-metering';
import { join } from 'path';
import { loadSystemPromptFile } from '@wispace/llm-agent';
import { WispaceGoalsService } from '@wispace/wispace-client';

const FEATURE = 'STUDENT_REPORT';
const PROMPT_DIR = join(__dirname, '../../../../shared/prompts');

/**
 * Thin NestJS adapter around the platform-agnostic `@wispace/student-report`
 * core (capacity fetch → LLM call → fallback → format). Discord counterpart
 * to Messenger's `StudentReportService`.
 */
@Injectable()
export class DiscordStudentReportService {
  private readonly logger = new Logger(DiscordStudentReportService.name);
  private core?: StudentReportCore;
  private readonly limiter: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly configService: ConfigService,
    private readonly goalsService: WispaceGoalsService,
    private readonly usageRecorder: PlatformLlmUsageRecorderAdapter,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
  ) {
    const maxConcurrent = Number(
      this.configService.get<string>('LLM_MAX_CONCURRENT') ?? '3',
    );
    // ponytail: p-limit instead of a hand-rolled active/queue limiter
    this.limiter = pLimit(
      Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 3,
    );
  }

  generateReport(discordUserId: string): Promise<string> {
    if (!this.core) {
      this.core = this.buildCore();
    }

    const timezone =
      this.configService.get<string>('STUDY_REMINDER_TIMEZONE')?.trim() ??
      'Asia/Ho_Chi_Minh';
    const correlationId = `${discordUserId}:${todayUsageDate(timezone)}`;

    return this.limiter(() =>
      this.core!.generateReport(discordUserId, { correlationId }),
    );
  }

  private buildCore(): StudentReportCore {
    const ports: StudentReportPorts = {
      llmExecution: {
        // ponytail: shared retry helper from llm-agent (was a local sleep+backoff copy)
        run: (fn) =>
          retryWithBackoff(fn, {
            maxAttempts: 3,
            baseDelayMs: 500,
            backoff: (attempt) => 500 * 2 ** (attempt - 1),
            isRetryable: (error) =>
              error instanceof Error &&
              (error.message.includes('rate limit') ||
                error.message.includes('429')),
            onRetry: (attempt, backoffMs, error) =>
              this.logger.warn(
                `LLM provider retry feature=${FEATURE} attempt=${attempt}/3 backoffMs=${backoffMs}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
          }),
      },
      usageRecorder: {
        recordFromCompletion: (params) =>
          this.usageRecorder.recordFromCompletion({
            feature: FEATURE,
            externalUserId: params.externalUserId,
            model: params.model,
            response: params.response as Parameters<
              PlatformLlmUsageRecorderAdapter['recordFromCompletion']
            >[0]['response'],
            correlationId: params.correlationId,
          }),
      },
      capacityData: {
        getCapacityData: async (
          externalUserId,
        ): Promise<StudentCapacityInput> => {
          const [taskScores, goals] = await Promise.all([
            this.goalsService.getTaskScoreAverages(externalUserId),
            this.goalsService.getUserGoals(externalUserId),
          ]);

          if (!taskScores || taskScores.length === 0) {
            throw new Error('No score data available');
          }

          const task1 = taskScores.find((r) =>
            r.task.toLowerCase().includes('task 1'),
          );
          const task2 = taskScores.find((r) =>
            r.task.toLowerCase().includes('task 2'),
          );

          const examDate = goals.examDate
            ? new Date(goals.examDate).toISOString().split('T')[0]
            : '';
          const currentDate = new Date().toISOString().split('T')[0];

          const examDateObj = examDate ? new Date(examDate) : null;
          const now = new Date();
          const daysUntilExam = examDateObj
            ? Math.ceil(
                (examDateObj.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
              )
            : 0;
          const examHasPassed = daysUntilExam < 0;

          return {
            exam_date: examDate,
            exam_date_display: examDate
              ? new Date(examDate).toLocaleDateString('vi-VN')
              : '',
            current_date: currentDate,
            days_until_exam: Math.max(0, daysUntilExam),
            exam_has_passed: examHasPassed,
            target_band: goals.targetScore ?? 0,
            task1_band: task1
              ? Math.round((task1.avgTotalScore ?? 0) * 10) / 10
              : 0,
            task2_band: task2
              ? Math.round((task2.avgTotalScore ?? 0) * 10) / 10
              : 0,
            total_essays_task1: task1?.task1Count ?? 0,
            total_essays_task2: task2?.task2Count ?? 0,
          };
        },
      },
      logger: {
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    };

    return new StudentReportCore(
      {
        adapter: this.adapter,
        systemPrompt: loadSystemPromptFile(
          PROMPT_DIR,
          'student-report.system.txt',
        ),
      },
      ports,
    );
  }
}
