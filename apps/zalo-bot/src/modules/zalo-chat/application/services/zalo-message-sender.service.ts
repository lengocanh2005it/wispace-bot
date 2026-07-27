import { Injectable, Logger } from '@nestjs/common';
import type {
  MessageSenderPort,
  SendMessageInput,
} from '@wispace/study-reminder-shared';
import { ZaloOutboundService } from './zalo-outbound.service';

/**
 * Wraps ZaloOutboundService to implement the shared MessageSenderPort.
 */
@Injectable()
export class ZaloMessageSenderService implements MessageSenderPort {
  private readonly logger = new Logger(ZaloMessageSenderService.name);

  constructor(private readonly outboundService: ZaloOutboundService) {}

  async sendText(input: SendMessageInput): Promise<void> {
    try {
      await this.outboundService.sendText(input.externalUserId, input.text);
    } catch (error) {
      this.logger.warn(
        `Failed to send study reminder to externalUserId=${input.externalUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}
