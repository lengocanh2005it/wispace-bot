import { Injectable, Logger } from '@nestjs/common';
import { Repository, type DeepPartial } from 'typeorm';
import { errorMessage } from '@wispace/bot-common';

/** Minimum column shape shared by the per-app message log entities. */
export interface MessageLogRow {
  externalUserId: string;
  status: string;
  error: string | null;
  messageType: string;
}

/**
 * Logs message delivery attempts for audit trail (SENT/FAILED with error
 * details) — shared by Discord and Zalo. Generic over the per-app message
 * log entity, which share the same column shape.
 */
@Injectable()
export class DeliveryLogService<Entity extends MessageLogRow = MessageLogRow> {
  private readonly logger = new Logger(DeliveryLogService.name);

  constructor(private readonly repo: Repository<Entity>) {}

  async logDelivery(input: {
    externalUserId: string;
    status: 'SENT' | 'FAILED';
    error?: string;
    messageType?: string;
  }): Promise<void> {
    try {
      await this.repo.save({
        externalUserId: input.externalUserId,
        status: input.status,
        error: input.error ?? null,
        messageType: input.messageType ?? 'chat',
      } as DeepPartial<Entity>);
    } catch (error) {
      this.logger.warn(`Failed to log delivery: ${errorMessage(error)}`);
    }
  }
}
