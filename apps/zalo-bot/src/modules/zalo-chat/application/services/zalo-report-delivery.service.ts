import { Injectable, Logger } from '@nestjs/common';
import { ZaloOutboundService, ZaloSendError } from './zalo-outbound.service';

@Injectable()
export class ZaloReportDeliveryService {
  private readonly logger = new Logger(ZaloReportDeliveryService.name);

  constructor(private readonly outbound: ZaloOutboundService) {}

  async sendReport(zaloUserId: string, text: string): Promise<boolean> {
    try {
      await this.outbound.sendText(zaloUserId, text);
      return true;
    } catch (error) {
      if (error instanceof ZaloSendError && error.is48hWindowError()) {
        this.logger.warn(
          `48h window closed for Zalo user ${zaloUserId}, report not delivered`,
        );
        return false;
      }
      this.logger.error(
        `Failed to send report to Zalo user ${zaloUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
