import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import type { LlmExecutionContext } from '@messenger/modules/llm-execution/application/types/llm-execution.types';
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

    return this.core.generateReport(psid, { correlationId });
  }

  private buildCore(): StudentReportCore {
    const ports: StudentReportPorts = {
      llmExecution: {
        run: (fn, meta) =>
          this.llmExecution.run(fn, meta as LlmExecutionContext),
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
