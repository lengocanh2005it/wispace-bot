import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TaskScoreAverageApiClient,
  type TaskScoreAverageRecord,
} from '@wispace/wispace-client';
import { StudentReportNoScoreDataError } from '../../domain/errors/student-report-no-score-data.error';
import type { StudentCapacityInput } from '@wispace/student-report';
import { UserGoalsApiService } from './user-goals-api.service';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';
// ponytail: shared date utils live in scheduler-core (same byte-identical copy was local)
import {
  formatExamDateDisplay,
  resolveExamCountdown,
  todayReportDate,
} from '@wispace/scheduler-core';
import { buildWispaceClientConfig } from './wispace-client-helpers';

const ID_HEADER = 'x-psid' as const;

@Injectable()
export class TaskScoreAverageApiService {
  private readonly logger = new Logger(TaskScoreAverageApiService.name);
  private client?: TaskScoreAverageApiClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly userGoalsApiService: UserGoalsApiService,
  ) {}

  async getCapacityData(
    psid: string,
    options?: { signal?: AbortSignal },
  ): Promise<StudentCapacityInput> {
    const records = await this.getClient().getTaskScoreAverages(
      ID_HEADER,
      psid,
      options,
    );

    if (records.length === 0) {
      throw new StudentReportNoScoreDataError(psid);
    }

    const goals = await this.userGoalsApiService.getUserGoals(psid, options);

    return this.mapToCapacityInput(records, goals);
  }

  private getClient(): TaskScoreAverageApiClient {
    if (!this.client) {
      this.client = new TaskScoreAverageApiClient(
        buildWispaceClientConfig(
          this.configService,
          'WISPACE_API_TASK_SCORE_URL',
          'https://backend.aihubproduction.com/api/TaskScoreAverage',
        ),
        {
          warn: (m) => this.logger.warn(m),
          log: (m) => this.logger.log(m),
        },
      );
    }

    return this.client;
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
      target_band: Number.isFinite(goals.targetScore)
        ? goals.targetScore
        : null,
      task1_band: this.roundBand(task1?.avgTotalScore),
      task2_band: this.roundBand(task2?.avgTotalScore),
      total_essays_task1: task1?.task1Count ?? null,
      total_essays_task2: task2?.task2Count ?? null,
    };
  }

  private roundBand(value?: number): number | null {
    if (value === undefined || !Number.isFinite(value)) {
      return null;
    }

    return Math.round(value * 10) / 10;
  }
}
