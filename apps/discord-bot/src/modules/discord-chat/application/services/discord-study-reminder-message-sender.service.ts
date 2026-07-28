import { Injectable, Logger } from '@nestjs/common';
import type {
  MessageSenderPort,
  SendMessageInput,
} from '@wispace/study-reminder-shared';
import { DiscordOutboundService } from './discord-outbound.service';

@Injectable()
export class DiscordStudyReminderMessageSenderService implements MessageSenderPort {
  private readonly logger = new Logger(
    DiscordStudyReminderMessageSenderService.name,
  );

  constructor(private readonly outboundService: DiscordOutboundService) {}

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
