import { Module } from '@nestjs/common';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { WispaceModule } from '../wispace/wispace.module';
import { StudentReportService } from './application/services/student-report.service';
import { TaskScoreAverageApiService } from './infrastructure/wispace/task-score-average-api.service';
import { CAPACITY_DATA } from './domain/ports/capacity-data.port';

@Module({
  imports: [LlmExecutionModule, LlmUsageModule, WispaceModule],
  providers: [
    TaskScoreAverageApiService,
    {
      provide: CAPACITY_DATA,
      useExisting: TaskScoreAverageApiService,
    },
    StudentReportService,
  ],
  exports: [StudentReportService, TaskScoreAverageApiService],
})
export class StudentReportModule {}
