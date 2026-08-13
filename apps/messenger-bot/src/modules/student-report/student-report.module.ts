import { Module } from '@nestjs/common';
import {
  WispaceConfigService,
  WispaceExerciseService,
} from '@wispace/wispace-client';
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
    WispaceConfigService,
    {
      provide: WispaceExerciseService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceExerciseService('x-psid', configService),
      inject: [WispaceConfigService],
    },
  ],
  exports: [
    StudentReportService,
    UserGoalsApiService,
    TaskScoreAverageApiService,
    WispaceExerciseService,
  ],
})
export class StudentReportModule {}
