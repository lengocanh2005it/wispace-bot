import { Injectable, Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type {
  ReportMapping,
  ClaimAndSendResult,
  ClassifiedError,
} from '@wispace/scheduler-core';
import { ReportOrchestrationService } from '@wispace/scheduler-core';
import { PlatformStudentReportService } from '@wispace/student-report';

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
    },
  ): Promise<ClaimAndSendResult> {
    return this.orchestration.claimAndSend(mapping, {
      reportDate: opts.reportDate,
      skipAlreadySentToday: opts.skipAlreadySentToday,
      reportText: '', // ignored when generateReport is provided
      examDateForOutbox: opts.examDateForOutbox,
      classifyError: classifyDiscordError,
      generateReport: async () => {
        this.logger.log(
          `Generating report for Discord user ${maskExternalId(mapping.externalUserId)}`,
        );
        return this.reportService.generateReport(mapping.externalUserId);
      },
    });
  }
}

function classifyDiscordError(error: unknown): ClassifiedError {
  return { kind: 'failure', message: String(error) };
}
