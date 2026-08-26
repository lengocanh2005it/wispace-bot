import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import type { ReportDeliveryPort } from '@wispace/scheduler-core';
import type { ReportDeliveryResult } from '@wispace/scheduler-core';
import {
  ZaloOutboundService,
  ZaloSendError,
  isZaloRetryableError,
} from './zalo-outbound.service';
import { WispaceApiError } from '@wispace/wispace-client';

/**
 * Zalo implementation of `ReportDeliveryPort` — wraps `sendTextForRetry`
 * and maps Zalo-specific outcomes/errors to the generic delivery result.
 */
@Injectable()
export class ZaloReportDeliveryService implements ReportDeliveryPort {
  private readonly logger = new Logger(ZaloReportDeliveryService.name);

  constructor(private readonly outbound: ZaloOutboundService) {}

  async sendReport(input: {
    mapping: { externalUserId: string; userId?: number };
    reportText: string;
    reportDate: string;
    deliveryKey?: string;
  }): Promise<ReportDeliveryResult> {
    const { mapping, reportText, deliveryKey } = input;

    try {
      const outcome = await this.outbound.sendTextForRetry(
        mapping.externalUserId,
        reportText,
        deliveryKey ??
          `zalo-report:${mapping.externalUserId}:${input.reportDate}`,
      );

      if (outcome === 'sent' || outcome === 'ambiguous') {
        return { ok: true };
      }

      return { ok: false, reason: 'DELIVERY_FAILED' };
    } catch (error) {
      this.logger.error(
        `Zalo report delivery failed for ${maskExternalId(mapping.externalUserId)}: ${errorMessage(error)}`,
      );

      if (error instanceof ZaloSendError && error.is48hWindowError()) {
        return { ok: false, reason: 'WINDOW_CLOSED' };
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
