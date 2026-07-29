import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscordMessageLogEntity } from '@discord/infrastructure/database/entities/discord-message-log.entity';

/**
 * Logs Discord message delivery attempts for audit trail.
 * Records SENT/FAILED with error details.
 */
@Injectable()
export class DiscordDeliveryLogService {
  private readonly logger = new Logger(DiscordDeliveryLogService.name);

  constructor(
    @InjectRepository(DiscordMessageLogEntity)
    private readonly repo: Repository<DiscordMessageLogEntity>,
  ) {}

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
      });
    } catch (error) {
      this.logger.warn(
        `Failed to log delivery: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
