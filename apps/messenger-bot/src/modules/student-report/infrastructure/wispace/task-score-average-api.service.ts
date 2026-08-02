import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TaskScoreAverageApiClient,
  type WispaceApiClientConfig,
} from '@wispace/wispace-client';
import { StudentReportNoScoreDataError } from '../../domain/errors/student-report-no-score-data.error';
import { TaskScoreAverageRecord } from '../../domain/types/task-score-average.types';
import type { StudentCapacityInput } from '@wispace/student-report';
import { UserGoalsApiService } from './user-goals-api.service';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';
// ponytail: shared date utils live in scheduler-core (same byte-identical copy was local)
import {
  formatExamDateDisplay,
  resolveExamCountdown,
  todayReportDate,
} from '@wispace/scheduler-core';

const ID_HEADER = 'x-psid' as const;

@Injectable()
export class TaskScoreAverageApiService {
  private readonly logger = new Logger(TaskScoreAverageApiService.name);
  private client?: TaskScoreAverageApiClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly userGoalsApiService: UserGoalsApiService,
  ) {}

  async getCapacityData(psid: string): Promise<StudentCapacityInput> {
    const records = await this.getClient().getTaskScoreAverages(
      ID_HEADER,
      psid,
    );

    if (records.length === 0) {
      throw new StudentReportNoScoreDataError(psid);
    }

    const goals = await this.userGoalsApiService.getUserGoals(psid);

    return this.mapToCapacityInput(records, goals);
  }

  private getClient(): TaskScoreAverageApiClient {
    if (!this.client) {
      this.client = new TaskScoreAverageApiClient(this.buildClientConfig(), {
        warn: (m) => this.logger.warn(m),
        log: (m) => this.logger.log(m),
      });
    }

    return this.client;
  }

  private buildClientConfig(): WispaceApiClientConfig {
    return {
      url:
        this.configService.get<string>('WISPACE_API_TASK_SCORE_URL') ??
        'https://backend.aihubproduction.com/api/TaskScoreAverage',
      internalKey: this.getInternalKey(),
      maxRetries: this.readPositiveInt('WISPACE_API_MAX_RETRIES', 3),
      baseDelayMs: this.readPositiveInt('WISPACE_API_RETRY_BASE_DELAY_MS', 500),
    };
  }

  private getInternalKey(): string {
    const key = this.configService.get<string>('WISPACE_INTERNAL_KEY')?.trim();
    if (!key) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set in .env',
      );
    }

    return key;
  }

  private readPositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : defaultValue;
  }

  private mapToCapacityInput(
    records: TaskScoreAverageRecord[],
    goals: { targetScore: number; examDate: string },
  ): StudentCapacityInput {
    const task1 = records.find((record) =>
      record.task.toLowerCase().includes('task 1'),
    );
    const task2 = records.find((record) =>
      record.task.toLowerCase().includes('task 2'),
    );

    const examDate = this.userGoalsApiService.parseExamDate(goals.examDate);
    const currentDate = todayReportDate(resolveAppTimezone(this.configService));
    const { daysUntilExam, examHasPassed } = resolveExamCountdown(
      examDate,
      currentDate,
    );

    return {
      exam_date: examDate,
      exam_date_display: formatExamDateDisplay(examDate),
      current_date: currentDate,
      days_until_exam: daysUntilExam,
      exam_has_passed: examHasPassed,
      target_band: goals.targetScore,
      task1_band: this.roundBand(task1?.avgTotalScore),
      task2_band: this.roundBand(task2?.avgTotalScore),
      total_essays_task1: task1?.task1Count ?? 0,
      total_essays_task2: task2?.task2Count ?? 0,
    };
  }

  private roundBand(value?: number): number {
    if (value === undefined || Number.isNaN(value)) {
      return 0;
    }

    return Math.round(value * 10) / 10;
  }
}
