import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ReportSendJobRepositoryPort,
  ReportClaimRepositoryPort,
  ReportDeliveryPort,
  ReportMapping,
  GoalsDataPort,
} from '@wispace/scheduler-core';
import {
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  REPORT_DELIVERY_PORT,
  GOALS_DATA_PORT,
  ReportScheduleService,
  ReportSendScheduleService,
} from '@wispace/scheduler-core';
import {
  DISCORD_REPORT_PORT,
  type DiscordReportPort,
} from '../../domain/ports/discord-report.port';

export interface ClaimAndSendResult {
  sent: number;
  skipped: number;
  deferred: number;
  windowClosed: number;
  claimSkipped: number;
  retryQueued: number;
  failures: Array<{ externalUserId: string; error: string }>;
}

const ZERO: ClaimAndSendResult = {
  sent: 0,
  skipped: 0,
  deferred: 0,
  windowClosed: 0,
  claimSkipped: 0,
  retryQueued: 0,
  failures: [],
};

@Injectable()
export class DiscordReportOrchestrationService {
  private readonly logger = new Logger(DiscordReportOrchestrationService.name);

  constructor(
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepository: ReportClaimRepositoryPort,
    @Inject(REPORT_DELIVERY_PORT)
    private readonly deliveryService: ReportDeliveryPort,
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly jobRepository: ReportSendJobRepositoryPort,
    @Inject(GOALS_DATA_PORT)
    private readonly goalsDataPort: GoalsDataPort,
    @Inject(DISCORD_REPORT_PORT)
    private readonly reportPort: DiscordReportPort,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly reportSendScheduleService: ReportSendScheduleService,
  ) {}

  async claimAndSend(
    mapping: ReportMapping,
    opts: {
      reportDate: string;
      skipAlreadySentToday: boolean;
      examDateForOutbox?: string;
    },
  ): Promise<ClaimAndSendResult> {
    const { reportDate, skipAlreadySentToday, examDateForOutbox } = opts;

    if (skipAlreadySentToday) {
      const alreadySent =
        await this.claimRepository.hasSentScheduledReportToday(
          mapping.externalUserId,
        );
      if (alreadySent) {
        if (examDateForOutbox) {
          await this.jobRepository.markSentByExternalUserExamDate(
            mapping.externalUserId,
            examDateForOutbox,
          );
        }
        return { ...ZERO, skipped: 1 };
      }
    }

    let claimedForSend = false;
    if (skipAlreadySentToday) {
      const claimed = await this.claimRepository.tryClaimScheduledReport({
        externalUserId: mapping.externalUserId,
        userId: mapping.userId,
        reportDate,
      });
      if (!claimed) {
        return { ...ZERO, claimSkipped: 1 };
      }
      claimedForSend = true;
    }

    try {
      const goals = await this.goalsDataPort.getUserGoals(
        mapping.externalUserId,
      );
      const examDate = this.goalsDataPort.parseExamDate(goals.examDate);
      const reportText = await this.reportPort.generateReport(
        mapping.externalUserId,
      );

      const result = await this.deliveryService.sendReport({
        mapping,
        reportText,
        reportDate,
      });

      if (result.ok) {
        if (claimedForSend) {
          await this.claimRepository.markScheduledReportClaimSent({
            externalUserId: mapping.externalUserId,
            reportDate,
          });
        }
        if (examDateForOutbox) {
          await this.jobRepository.markSentByExternalUserExamDate(
            mapping.externalUserId,
            examDateForOutbox,
          );
        }
        return { ...ZERO, sent: 1 };
      }

      if (claimedForSend) {
        await this.claimRepository.releaseScheduledReportClaim({
          externalUserId: mapping.externalUserId,
          reportDate,
        });
      }

      if (result.reason === 'RETRYABLE') {
        const settings = this.reportSendScheduleService.getOutboxSettings();
        const nextRetryAt = new Date(
          Date.now() + settings.retryBackoffMinutes * 60 * 1000,
        );
        await this.jobRepository.recordRetryableFailure({
          platform: mapping.platform,
          externalUserId: mapping.externalUserId,
          userId: mapping.userId,
          examDate,
          firstAttemptDate: reportDate,
          maxRetries: settings.maxRetries,
          nextRetryAt,
          errorMessage: `Delivery failed: ${result.reason}`,
        });
        return { ...ZERO, deferred: 1, retryQueued: 1 };
      }

      return { ...ZERO, windowClosed: 1 };
    } catch (error) {
      if (claimedForSend) {
        await this.claimRepository.releaseScheduledReportClaim({
          externalUserId: mapping.externalUserId,
          reportDate,
        });
      }
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ...ZERO,
        failures: [{ externalUserId: mapping.externalUserId, error: msg }],
      };
    }
  }
}
