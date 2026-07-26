import { Module } from '@nestjs/common';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { LlmSafetyModule } from '../llm-safety/llm-safety.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerAgentToolsService } from './application/agent/messenger-agent-tools.service';
import { MessengerAgentService } from './application/agent/messenger-agent.service';
import { MessengerChatSharedConfigService } from './application/services/messenger-chat-shared-config.service';
import { MessengerChatQueueService } from './application/services/messenger-chat-queue.service';
import { MessengerChatQueueWorkerService } from './application/services/messenger-chat-queue-worker.service';
import { MessengerRescheduleConfirmationService } from './application/services/messenger-reschedule-confirmation.service';
import { ChatHistoryStoreStartupService } from './application/services/chat-history-store-startup.service';
import { ChatQueueStoreStartupService } from './application/services/chat-queue-store-startup.service';
import { CHAT_QUEUE_STORE } from './domain/repositories/chat-queue.store.port';
import { CHAT_HISTORY_STORE } from './domain/repositories/chat-history.store.port';
import { ChatQueueStoreResolver } from './infrastructure/persistence/chat-queue.store.resolver';
import { RedisChatQueueStore } from './infrastructure/persistence/redis-chat-queue.store';
import { ChatHistoryStoreResolver } from './infrastructure/persistence/chat-history.store.resolver';
import { MemoryChatHistoryStore } from './infrastructure/persistence/memory-chat-history.store';
import { RedisChatHistoryStore } from './infrastructure/persistence/redis-chat-history.store';
import { GOALS_DATA_PORT } from './domain/ports/goals-data.port';
import { REPORT_PORT } from './domain/ports/report.port';
import { STUDY_DATA_PORT } from './domain/ports/study-data.port';
import { StudyDataAdapter } from './infrastructure/adapters/study-data.adapter';
import { UserGoalsApiService } from '../student-report/infrastructure/wispace/user-goals-api.service';
import { StudentReportService } from '../student-report/application/services/student-report.service';

/**
 * Self-contained module for the chat pipeline:
 * debounce → rate limit → LLM agent → send.
 *
 * Exports: MessengerChatQueueService, MessengerAgentService,
 * MessengerAgentToolsService, MessengerRescheduleConfirmationService.
 */
@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    ChatRateLimitModule,
    LlmExecutionModule,
    LlmUsageModule,
    LlmSafetyModule,
    StudentReportModule,
    StudyReminderModule,
  ],
  providers: [
    MessengerChatSharedConfigService,
    MemoryChatHistoryStore,
    RedisChatHistoryStore,
    ChatHistoryStoreResolver,
    ChatHistoryStoreStartupService,
    {
      provide: CHAT_HISTORY_STORE,
      useExisting: ChatHistoryStoreResolver,
    },
    RedisChatQueueStore,
    ChatQueueStoreResolver,
    ChatQueueStoreStartupService,
    {
      provide: CHAT_QUEUE_STORE,
      useExisting: ChatQueueStoreResolver,
    },
    {
      provide: GOALS_DATA_PORT,
      useFactory: (goalsApi: UserGoalsApiService) => ({
        getUserGoals: (psid: string) => goalsApi.getUserGoals(psid),
      }),
      inject: [UserGoalsApiService],
    },
    {
      provide: REPORT_PORT,
      useFactory: (reportService: StudentReportService) => ({
        generateReport: (psid: string) => reportService.generateReport(psid),
      }),
      inject: [StudentReportService],
    },
    StudyDataAdapter,
    {
      provide: STUDY_DATA_PORT,
      useExisting: StudyDataAdapter,
    },
    MessengerChatQueueService,
    MessengerChatQueueWorkerService,
    MessengerAgentService,
    MessengerAgentToolsService,
    MessengerRescheduleConfirmationService,
  ],
  exports: [
    MessengerChatQueueService,
    MessengerAgentService,
    MessengerAgentToolsService,
    MessengerRescheduleConfirmationService,
    MessengerChatSharedConfigService,
  ],
})
export class ChatPipelineModule {}
