import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlatformLlmUsageRecorderAdapter,
  todayUsageDate,
} from '@wispace/chat-metering';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common';
import type { Platform } from '@wispace/database';
import type {
  UserGoalsRecord,
  TaskScoreAverageRecord,
} from '@wispace/wispace-client';
import {
  createEnvLlmExecutionPort,
  type AdmissionMetrics,
  loadSystemPromptFile,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import {
  StudentReportCore,
  type StudentReportPorts,
} from './student-report.service';
import type { StudentCapacityInput } from './types';

const FEATURE = 'STUDENT_REPORT';

/** Structural goals-port accepted by the report service — satisfied by both
 * `WispaceGoalsService` and the request-scoped memoized wrapper. */
export interface ReportGoalsPort {
  getUserGoals(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserGoalsRecord>;
  getTaskScoreAverages(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskScoreAverageRecord[]>;
}

// Execution-control defaults — same contract and env keys as the Messenger
// app's `LlmExecutionConfigService`, so Discord/Zalo reports share the same
// documented path as chat and Messenger reports.
import { buildLlmExecutionConfig } from '@wispace/llm-agent';

/**
 * Thin NestJS adapter around the platform-agnostic `StudentReportCore`
 * (capacity fetch → LLM call → fallback → format), shared by Discord and
 * Zalo. The correlation id prefix is the platform user id itself, so the
 * `platform` param is reserved for future per-platform behavior.
 */
@Injectable()
export class PlatformStudentReportService {
  private readonly logger = new Logger(PlatformStudentReportService.name);
  private core?: StudentReportCore;

  constructor(
    private readonly platform: Platform,
    private readonly configService: ConfigService,
    private readonly goalsService: ReportGoalsPort,
    private readonly usageRecorder: PlatformLlmUsageRecorderAdapter,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    private readonly promptDir: string,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: RedisClientPort,
    @Optional()
    private readonly llmAdmissionMetrics?: AdmissionMetrics,
  ) {}

  generateReport(externalUserId: string): Promise<string> {
    if (!this.core) {
      this.core = this.buildCore();
    }

    const timezone =
      this.configService.get<string>('STUDY_REMINDER_TIMEZONE')?.trim() ??
      'Asia/Ho_Chi_Minh';
    const correlationId = `${externalUserId}:${todayUsageDate(timezone)}`;

    return this.core.generateReport(externalUserId, { correlationId });
  }

  private buildCore(): StudentReportCore {
    const config = buildLlmExecutionConfig();

    const ports: StudentReportPorts = {
      // ponytail: shared execution-control port from llm-agent (was a local
      // hardcoded sleep+backoff copy) — same LLM_EXECUTION_* contract as chat.
      llmExecution: createEnvLlmExecutionPort(
        {
          ...config,
          redis: config.globalConcurrencyEnabled
            ? (this.redisClient?.getNativeClient() ?? null)
            : null,
        },
        this.adapter,
        { warn: (message) => this.logger.warn(message) },
        this.llmAdmissionMetrics,
      ),
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
          this.promptDir,
          'student-report.system.txt',
        ),
      },
      ports,
    );
  }

  private readEnvBoolean(key: string, defaultValue: boolean): boolean {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null) return defaultValue;
    return raw.toLowerCase() === 'true';
  }

  private readEnvPositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key);
    if (raw === undefined || raw === null) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : defaultValue;
  }
}
