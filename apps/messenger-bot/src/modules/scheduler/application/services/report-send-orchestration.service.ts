import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { readReportClaimLeaseMs } from '@wispace/database';
import {
  REPORT_CLAIM_REPOSITORY,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import type { UserMessengerMapping } from '@messenger/modules/messenger/domain/entities/messenger.types';
import { MessengerReportDeliveryService } from '@messenger/modules/messenger/application/services/messenger-report-delivery.service';
import {
  MessengerApiError,
  MessengerPartialSendError,
  isMessengerAmbiguousDeliveryError,
} from '@messenger/modules/messenger/application/services/messenger-outbound.service';
import {
  REPORT_SEND_JOB_REPOSITORY,
  type ReportSendJobRepositoryPort,
} from '@wispace/scheduler-core';
import { ReportSendScheduleService } from '@wispace/scheduler-core';
import type { ClaimAndSendResult } from '@wispace/scheduler-core';
import { isStudentReportRetryableError } from '@wispace/student-report';
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

/** Meta Send API 5xx / 408 timeout / network-level 0 — retryable via R5 outbox. */
function isMessengerApiRetryable(error: unknown): boolean {
  if (error instanceof MessengerPartialSendError) {
    return false;
  }
  if (error instanceof MessengerApiError) {
    return error.status >= 500 || error.status === 0;
  }
  return false;
}

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
    private readonly configService: ConfigService,
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
          `Skip PSID ${maskExternalId(
            mapping.psid,
          )}: scheduled report already sent today`,
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
    let claimLeaseToken = '';
    let claimDeliveryRecord: string | undefined;
    if (skipAlreadySentToday) {
      const claimed: {
        claimed: boolean;
        leaseToken?: string;
        deliveryRecord?: string;
      } = await this.messengerRepository.tryClaimScheduledReport(
        {
          externalUserId: mapping.psid,
          userId: mapping.userId,
          reportDate,
        },
        readReportClaimLeaseMs(this.configService),
      );
      if (!claimed.claimed || !claimed.leaseToken) {
        this.logger.log(
          `Skip PSID ${maskExternalId(
            mapping.psid,
          )}: report claim exists for ${reportDate} (R4)`,
        );
        return { ...ZERO, claimSkipped: 1 };
      }
      claimedForSend = true;
      claimLeaseToken = claimed.leaseToken;
      claimDeliveryRecord =
        typeof claimed.deliveryRecord === 'string'
          ? claimed.deliveryRecord
          : undefined;
    }

    // Skip re-send if already delivered (#181) — crash between send and
    // markSent left a delivery_record; re-claim sees it and marks sent
    // without re-sending.
    if (claimedForSend && claimDeliveryRecord) {
      await this.messengerRepository.markScheduledReportClaimSent(
        { externalUserId: mapping.psid, reportDate },
        claimLeaseToken,
      );
      return { ...ZERO, sent: 1 };
    }

    try {
      const deliveryKey = `messenger-report:${mapping.psid}:${reportDate}`;

      const result =
        await this.messengerReportDeliveryService.sendReportForMapping(mapping);

      if (result) {
        if (claimedForSend) {
          await this.messengerRepository.markScheduledReportClaimSent(
            {
              externalUserId: mapping.psid,
              reportDate,
            },
            claimLeaseToken,
            'sent',
            deliveryKey,
          );
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
        await this.messengerRepository.releaseScheduledReportClaim(
          {
            externalUserId: mapping.psid,
            reportDate,
          },
          claimLeaseToken,
        );
      }
      return { ...ZERO, windowClosed: 1 };
    } catch (error) {
      // Partial send: user already received ≥1 bubble — mark as sent with
      // delivery key so cross-platform dedupe works. The daily slot is burned
      // because the user already received content (#294).
      if (error instanceof MessengerPartialSendError) {
        const deliveryKey = `messenger-report:${mapping.psid}:${reportDate}`;
        this.logger.warn(
          `Partial report send for PSID ${maskExternalId(
            mapping.psid,
          )}: ${error.bubblesSent} bubble(s) delivered before failure — marking sent`,
        );
        if (claimedForSend) {
          if (isMessengerAmbiguousDeliveryError(error)) {
            await this.messengerRepository.markScheduledReportClaimSent(
              {
                externalUserId: mapping.psid,
                reportDate,
              },
              claimLeaseToken,
              'sent',
              deliveryKey,
              'ambiguous',
            );
          } else {
            await this.messengerRepository.markScheduledReportClaimSent(
              {
                externalUserId: mapping.psid,
                reportDate,
              },
              claimLeaseToken,
              'sent',
              deliveryKey,
            );
          }
        }
        if (examDateForOutbox) {
          await this.reportSendJobRepository.markSentByExternalUserExamDate(
            mapping.psid,
            examDateForOutbox,
          );
        }
        return { ...ZERO, sent: 1 };
      }

      // A Send API timeout has no delivery verdict. Burn the scheduled slot
      // with an explicit ambiguous outcome; retrying could duplicate a report.
      if (isMessengerAmbiguousDeliveryError(error)) {
        const deliveryKey = `messenger-report:${mapping.psid}:${reportDate}`;
        if (claimedForSend) {
          await this.messengerRepository.markScheduledReportClaimSent(
            {
              externalUserId: mapping.psid,
              reportDate,
            },
            claimLeaseToken,
            'sent',
            deliveryKey,
            'ambiguous',
          );
          if (examDateForOutbox) {
            await this.reportSendJobRepository.markSentByExternalUserExamDate(
              mapping.psid,
              examDateForOutbox,
            );
          }
          return { ...ZERO, sent: 1 };
        }
      }

      // Release the claim on EVERY other failure — a leak here would silently
      // block same-day re-sends and burn the day's slot.
      if (claimedForSend) {
        await this.messengerRepository.releaseScheduledReportClaim(
          {
            externalUserId: mapping.psid,
            reportDate,
          },
          claimLeaseToken,
        );
      }

      if (
        isStudentReportRetryableError(error) ||
        isMessengerApiRetryable(error)
      ) {
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
              errorMessage: errorMessage(error, mapping.psid),
            },
          );
          if (job.nextRetryAt) retryQueued = 1;
        }
        this.logger.warn(
          `Deferred scheduled report for PSID ${maskExternalId(
            mapping.psid,
          )} (retryable, R3/R5)`,
        );
        return { ...ZERO, deferred: 1, retryQueued };
      }

      if (error instanceof ProactiveMessenger24hSkippedError) {
        this.logger.warn(
          `Skipped scheduled report for PSID ${maskExternalId(
            mapping.psid,
          )} (Messenger 24h window, L2)`,
        );
        return { ...ZERO, windowClosed: 1 };
      }

      const message = errorMessage(error, mapping.psid);
      this.logger.error(
        `Failed to send report for PSID ${maskExternalId(mapping.psid)}`,
        error,
      );
      return {
        ...ZERO,
        failures: [{ externalUserId: mapping.psid, error: message }],
      };
    }
  }
}
