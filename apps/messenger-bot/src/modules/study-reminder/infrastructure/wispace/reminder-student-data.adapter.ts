import { Injectable } from '@nestjs/common';
import { UserGoalsApiService } from '../../../student-report/infrastructure/wispace/user-goals-api.service';
import { TaskScoreAverageApiService } from '../../../student-report/infrastructure/wispace/task-score-average-api.service';
import type { ReminderStudentDataPort } from '../../domain/ports/reminder-student-data.port';

/**
 * WISPACE HTTP implementation of `ReminderStudentDataPort` for study-reminder
 * enrichment (goals + capacity bands) — keeps the reminder use case off the
 * concrete student-report infra services.
 */
@Injectable()
export class ReminderStudentDataAdapter implements ReminderStudentDataPort {
  constructor(
    private readonly goalsApi: UserGoalsApiService,
    private readonly taskScoreAverageApi: TaskScoreAverageApiService,
  ) {}

  getUserGoals(
    psid: string,
  ): Promise<{ targetScore?: number; examDate?: string }> {
    return this.goalsApi.getUserGoals(psid);
  }

  getCapacityData(psid: string): Promise<{
    task1_band?: number;
    task2_band?: number;
    target_band?: number;
  }> {
    return this.taskScoreAverageApi.getCapacityData(psid);
  }
}
