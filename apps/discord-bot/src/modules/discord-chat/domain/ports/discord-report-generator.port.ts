import type {
  LlmExecutionAttempt,
  LlmExecutionRetryCause,
} from '@wispace/llm-agent/core';

/**
 * Report generation seam for the Discord report orchestration (#1088). The
 * concrete generator (`PlatformStudentReportService` in
 * `@wispace/student-report/adapters`) stays wired in the module; the
 * application service only needs "give me the report prose for this user".
 */
export interface DiscordReportGeneratorPort {
  generateReport(
    externalUserId: string,
    options?: {
      attempt?: LlmExecutionAttempt;
      retryCause?: LlmExecutionRetryCause;
      userId?: number;
    },
  ): Promise<string>;
}

export const DISCORD_REPORT_GENERATOR = Symbol('DISCORD_REPORT_GENERATOR');
