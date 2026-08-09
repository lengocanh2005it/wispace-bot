import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import {
  REPORT_CLAIM_REPOSITORY,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import type { UserMessengerMapping } from '@messenger/modules/messenger/domain/entities/messenger.types';
import { MessengerReportDeliveryService } from '@messenger/modules/messenger/application/services/messenger-report-delivery.service';
import {
  REPORT_SEND_JOB_REPOSITORY,
  type ReportSendJobRepositoryPort,
} from '@wispace/scheduler-core';
import { ReportSendScheduleService } from '@wispace/scheduler-core';
import type { ClaimAndSendResult } from '@wispace/scheduler-core';
import { StudentReportRetryableError } from '@messenger/modules/student-report/domain/errors/wispace-api.error';
import { ProactiveMessenger24hSkippedError } from '@messenger/modules/messenger/application/utils/proactive-send.utils';

export const ZERO: ClaimAndSendResult = {
  sent: 0,
  skipped: 0,
  deferred: 0,
  windowClosed: 0,
  claimSkipped: 0,
  retryQueued: 0,
  failures: [],
};

/**
 * Shared orchestration for report send — claim → send → mark → error classify.
 * Used by both daily batch (ReportCronService) and retry outbox (ReportSendRetryDispatchService).
 */
@Injectable()
export class ReportSendOrchestrationService {
  private readonly logger = new Logger(ReportSendOrchestrationService.name);

  constructor(
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly messengerRepository: ReportClaimRepositoryPort,
    private readonly messengerReportDeliveryService: MessengerReportDeliveryService,
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly reportSendJobRepository: ReportSendJobRepositoryPort,
    private readonly reportSendScheduleService: ReportSendScheduleService,
  ) {}

  /**
   * Core: check sent today → try claim → send → mark/error.
   *
   * @param examDateForOutbox - exam date to record in outbox (undefined = skip outbox tracking)
   */
  async claimAndSend(
    mapping: UserMessengerMapping,
    opts: {
      reportDate: string;
      skipAlreadySentToday: boolean;
      examDateForOutbox?: string;
    },
  ): Promise<ClaimAndSendResult> {
    const { reportDate, skipAlreadySentToday, examDateForOutbox } = opts;

    if (!mapping.psid) {
      this.logger.log(`Skip mapping ${mapping.id}: missing PSID`);
      return { ...ZERO, skipped: 1 };
    }

    if (skipAlreadySentToday) {
      const alreadySentToday =
        await this.messengerRepository.hasSentScheduledReportToday(
          mapping.psid,
        );
      if (alreadySentToday) {
        this.logger.log(
          `Skip PSID ${mapping.psid}: scheduled report already sent today`,
        );
        if (examDateForOutbox) {
          await this.reportSendJobRepository.markSentByExternalUserExamDate(
            mapping.psid,
            examDateForOutbox,
          );
        }
        return { ...ZERO, skipped: 1 };
      }
    }

    let claimedForSend = false;
    if (skipAlreadySentToday) {
      const claimed = await this.messengerRepository.tryClaimScheduledReport({
        externalUserId: mapping.psid,
        userId: mapping.userId,
        reportDate,
      });
      if (!claimed) {
        this.logger.log(
          `Skip PSID ${mapping.psid}: report claim exists for ${reportDate} (R4)`,
        );
        return { ...ZERO, claimSkipped: 1 };
      }
      claimedForSend = true;
    }

    try {
      const result =
        await this.messengerReportDeliveryService.sendReportForMapping(mapping);

      if (result) {
        if (claimedForSend) {
          await this.messengerRepository.markScheduledReportClaimSent({
            externalUserId: mapping.psid,
            reportDate,
          });
        }
        if (examDateForOutbox) {
          await this.reportSendJobRepository.markSentByExternalUserExamDate(
            mapping.psid,
            examDateForOutbox,
          );
        }
        return { ...ZERO, sent: 1 };
      }

      if (claimedForSend) {
        await this.messengerRepository.releaseScheduledReportClaim({
          externalUserId: mapping.psid,
          reportDate,
        });
      }
      return { ...ZERO, windowClosed: 1 };
    } catch (error) {
      if (claimedForSend) {
        if (
          error instanceof StudentReportRetryableError ||
          error instanceof ProactiveMessenger24hSkippedError
        ) {
          await this.messengerRepository.releaseScheduledReportClaim({
            externalUserId: mapping.psid,
            reportDate,
          });
        }
      }

      if (error instanceof StudentReportRetryableError) {
        let retryQueued = 0;
        if (examDateForOutbox) {
          const settings = this.reportSendScheduleService.getOutboxSettings();
          const nextRetryAt = new Date(
            Date.now() + settings.retryBackoffMinutes * 60 * 1000,
          );
          const job = await this.reportSendJobRepository.recordRetryableFailure(
            {
              platform: 'messenger',
              externalUserId: mapping.psid,
              userId: mapping.userId,
              examDate: examDateForOutbox,
              firstAttemptDate: reportDate,
              maxRetries: settings.maxRetries,
              nextRetryAt,
              errorMessage: error.message,
            },
          );
          if (job.nextRetryAt) retryQueued = 1;
        }
        this.logger.warn(
          `Deferred scheduled report for PSID ${mapping.psid} (Wispace API retryable, R3/R5)`,
        );
        return { ...ZERO, deferred: 1, retryQueued };
      }

      if (error instanceof ProactiveMessenger24hSkippedError) {
        this.logger.warn(
          `Skipped scheduled report for PSID ${mapping.psid} (Messenger 24h window, L2)`,
        );
        return { ...ZERO, windowClosed: 1 };
      }

      const message = errorMessage(error);
      this.logger.error(
        `Failed to send report for PSID ${mapping.psid}`,
        error,
      );
      return {
        ...ZERO,
        failures: [{ externalUserId: mapping.psid, error: message }],
      };
    }
  }
}
