import { Injectable, Logger } from '@nestjs/common';
import type {
  ReportMapping,
  ClaimAndSendResult,
  ClassifiedError,
} from '@wispace/scheduler-core';
import { ReportOrchestrationService } from '@wispace/scheduler-core';
import { PlatformStudentReportService } from '@wispace/student-report';

/**
 * Discord-specific wrapper around the shared `ReportOrchestrationService`.
 * Generates report text and provides the Discord-specific error classifier.
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
    try {
      const reportText = await this.reportService.generateReport(
        mapping.externalUserId,
      );

      return this.orchestration.claimAndSend(mapping, {
        reportDate: opts.reportDate,
        skipAlreadySentToday: opts.skipAlreadySentToday,
        reportText,
        examDateForOutbox: opts.examDateForOutbox,
        classifyError: classifyDiscordError,
      });
    } catch (error) {
      this.logger.error(
        `Report generation failed for Discord user ${mapping.externalUserId}: ${error}`,
      );
      return {
        sent: 0,
        skipped: 0,
        deferred: 0,
        windowClosed: 0,
        claimSkipped: 0,
        retryQueued: 0,
        failures: [
          {
            externalUserId: mapping.externalUserId,
            error: String(error),
          },
        ],
      };
    }
  }
}

function classifyDiscordError(error: unknown): ClassifiedError {
  return { kind: 'failure', message: String(error) };
}
