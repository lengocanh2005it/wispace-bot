import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import type { ReportDeliveryPort } from '@wispace/scheduler-core';
import type { ReportDeliveryResult } from '@wispace/scheduler-core';
import {
  ZaloOutboundService,
  ZaloSendError,
  isZaloAmbiguousDeliveryError,
  isZaloRetryableError,
} from './zalo-outbound.service';
import { WispaceApiError } from '@wispace/wispace-client';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';

/**
 * Zalo implementation of `ReportDeliveryPort` — the report outbox owns
 * retryable failures; ambiguous sends are persisted for operator recovery.
 */
@Injectable()
export class ZaloReportDeliveryService implements ReportDeliveryPort {
  private readonly logger = new Logger(ZaloReportDeliveryService.name);

  constructor(
    private readonly outbound: ZaloOutboundService,
    private readonly accountLinkService: ZaloAccountLinkService,
  ) {}

  async sendReport(input: {
    mapping: { externalUserId: string; userId?: number };
    reportText: string;
    reportDate: string;
    deliveryKey?: string;
  }): Promise<ReportDeliveryResult> {
    const { mapping, reportText, deliveryKey } = input;

    try {
      const current = await this.accountLinkService.findCurrentIdentity(
        mapping.externalUserId,
      );
      if (
        !current ||
        (mapping.userId !== undefined && current.userId !== mapping.userId)
      ) {
        this.logger.warn(
          `Skip Zalo report for inactive mapping ${maskExternalId(mapping.externalUserId)}`,
        );
        return { ok: false, reason: 'NOT_LINKED' };
      }

      await this.outbound.sendText(mapping.externalUserId, reportText, {
        deliveryKey:
          deliveryKey ??
          `zalo-report:${mapping.externalUserId}:${input.reportDate}`,
        deadLetterOn: 'ambiguous',
        retryOn: 'none',
      });
      return { ok: true, outcome: 'sent' };
    } catch (error) {
      this.logger.error(
        `Zalo report delivery failed for ${maskExternalId(mapping.externalUserId)}: ${errorMessage(error, mapping.externalUserId)}`,
      );

      if (error instanceof ZaloSendError && error.is48hWindowError()) {
        return { ok: false, reason: 'WINDOW_CLOSED' };
      }

      if (isZaloAmbiguousDeliveryError(error)) {
        return { ok: true, outcome: 'ambiguous' };
      }

      if (
        error instanceof WispaceApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        return { ok: false, reason: 'WINDOW_CLOSED' };
      }

      if (isZaloRetryableError(error)) {
        return { ok: false, reason: 'RETRYABLE' };
      }

      return { ok: false, reason: 'DELIVERY_FAILED' };
    }
  }
}
