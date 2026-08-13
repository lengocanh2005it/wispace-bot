import { Module } from '@nestjs/common';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { StudentReportService } from './application/services/student-report.service';
import { TaskScoreAverageApiService } from './infrastructure/wispace/task-score-average-api.service';
import { UserGoalsApiService } from './infrastructure/wispace/user-goals-api.service';

@Module({
  imports: [LlmExecutionModule, LlmUsageModule],
  providers: [
    UserGoalsApiService,
    TaskScoreAverageApiService,
    StudentReportService,
  ],
  exports: [
    StudentReportService,
    UserGoalsApiService,
    TaskScoreAverageApiService,
  ],
})
export class StudentReportModule {}
