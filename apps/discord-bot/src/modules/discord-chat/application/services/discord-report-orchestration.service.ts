import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { buildReportOptOutFooter } from '@wispace/bot-common/messages';
import type {
  ReportMapping,
  ClaimAndSendResult,
  ClassifiedError,
  ReportOrchestrationPort,
} from '@wispace/scheduler-core/core';
import { REPORT_ORCHESTRATION } from '../../domain/ports/report-cron-seams.port';
import { isStudentReportRetryableError } from '@wispace/student-report/core';
import { LlmOverloadError } from '@wispace/llm-agent/core';
import type {
  LlmExecutionAttempt,
  LlmExecutionRetryCause,
} from '@wispace/llm-agent/core';
import {
  DISCORD_REPORT_GENERATOR,
  type DiscordReportGeneratorPort,
} from '../../domain/ports/discord-report-generator.port';

/**
 * Discord-specific wrapper around the shared ReportOrchestrationService.
 * Passes a generateReport callback so generation happens INSIDE the claim
 * window — generation failures become retryable via the outbox.
 */
@Injectable()
export class DiscordReportOrchestrationService {
  private readonly logger = new Logger(DiscordReportOrchestrationService.name);

  constructor(
    @Inject(REPORT_ORCHESTRATION)
    private readonly orchestration: ReportOrchestrationPort,
    @Inject(DISCORD_REPORT_GENERATOR)
    private readonly reportService: DiscordReportGeneratorPort,
  ) {}

  async claimAndSend(
    mapping: ReportMapping,
    opts: {
      reportDate: string;
      skipAlreadySentToday: boolean;
      allowUserIdLess?: boolean;
      examDateForOutbox?: string;
      /** One-time opt-out footer for grandfathered learners (#596). */
      appendOptOutFooter?: boolean;
      attempt?: LlmExecutionAttempt;
      retryCause?: LlmExecutionRetryCause;
    },
  ): Promise<ClaimAndSendResult> {
    return this.orchestration.claimAndSend(mapping, {
      reportDate: opts.reportDate,
      skipAlreadySentToday: opts.skipAlreadySentToday,
      ...(opts.allowUserIdLess ? { allowUserIdLess: true } : {}),
      reportText: '', // ignored when generateReport is provided
      examDateForOutbox: opts.examDateForOutbox,
      classifyError: (error) =>
        classifyDiscordError(error, mapping.externalUserId),
      generateReport: async () => {
        this.logger.log(
          `Generating report for Discord user ${maskExternalId(mapping.externalUserId)}`,
        );
        const reportOptions = {
          ...(opts.attempt ? { attempt: opts.attempt } : {}),
          ...(opts.retryCause ? { retryCause: opts.retryCause } : {}),
          ...(mapping.userId !== undefined ? { userId: mapping.userId } : {}),
        };
        const report = await this.reportService.generateReport(
          mapping.externalUserId,
          reportOptions,
        );
        return opts.appendOptOutFooter
          ? report + buildReportOptOutFooter()
          : report;
      },
    });
  }
}

function classifyDiscordError(
  error: unknown,
  externalUserId?: string,
): ClassifiedError {
  if (isStudentReportRetryableError(error)) {
    return {
      kind: 'retryable',
      message: 'Report generation temporarily unavailable',
      ...(error instanceof LlmOverloadError &&
      error.reason !== 'redis_unavailable'
        ? { retryCause: 'capacity_overload' as const }
        : {}),
    };
  }
  return { kind: 'failure', message: errorMessage(error, externalUserId) };
}
