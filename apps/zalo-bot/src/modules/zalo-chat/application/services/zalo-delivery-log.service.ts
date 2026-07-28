import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ZaloMessageLogEntity } from '../../../../infrastructure/database/entities/zalo-message-log.entity';

@Injectable()
export class ZaloDeliveryLogService {
  private readonly logger = new Logger(ZaloDeliveryLogService.name);

  constructor(
    @InjectRepository(ZaloMessageLogEntity)
    private readonly repo: Repository<ZaloMessageLogEntity>,
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
