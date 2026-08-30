import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { buildReportOptOutFooter } from '@wispace/bot-common/messages';
import type {
  ReportMapping,
  ClaimAndSendResult,
  ClassifiedError,
} from '@wispace/scheduler-core';
import { ReportOrchestrationService } from '@wispace/scheduler-core';
import {
  isStudentReportRetryableError,
  PlatformStudentReportService,
} from '@wispace/student-report';

/**
 * Discord-specific wrapper around the shared ReportOrchestrationService.
 * Passes a generateReport callback so generation happens INSIDE the claim
 * window — generation failures become retryable via the outbox.
 */
@Injectable()
export class DiscordReportOrchestrationService {
  private readonly logger = new Logger(DiscordReportOrchestrationService.name);

  constructor(
    private readonly orchestration: ReportOrchestrationService,
    private readonly reportService: PlatformStudentReportService,
  ) {}

  async claimAndSend(
    mapping: ReportMapping,
    opts: {
      reportDate: string;
      skipAlreadySentToday: boolean;
      examDateForOutbox?: string;
      /** One-time opt-out footer for grandfathered learners (#596). */
      appendOptOutFooter?: boolean;
    },
  ): Promise<ClaimAndSendResult> {
    return this.orchestration.claimAndSend(mapping, {
      reportDate: opts.reportDate,
      skipAlreadySentToday: opts.skipAlreadySentToday,
      reportText: '', // ignored when generateReport is provided
      examDateForOutbox: opts.examDateForOutbox,
      classifyError: (error) =>
        classifyDiscordError(error, mapping.externalUserId),
      generateReport: async () => {
        this.logger.log(
          `Generating report for Discord user ${maskExternalId(mapping.externalUserId)}`,
        );
        const report = await this.reportService.generateReport(
          mapping.externalUserId,
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
    };
  }
  return { kind: 'failure', message: errorMessage(error, externalUserId) };
}
