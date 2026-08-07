import type { Provider } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookDeadLetterEntity } from '../entities/webhook-dead-letter.entity';
import type { EntityClass } from '../typeorm-options';
import type { Platform } from '../types';
import { DeliveryLogService, type MessageLogRow } from './delivery-log.service';
import { PlatformDeadLetterService } from './platform-dead-letter.service';

/**
 * NestJS provider factories for the shared delivery-log / dead-letter
 * services — replaces the near-identical `useFactory` blocks in the Discord
 * and Zalo outbound/chat modules.
 */
export function createDeliveryLogProvider<
  Entity extends MessageLogRow = MessageLogRow,
>(messageLogEntity: EntityClass): Provider {
  return {
    provide: DeliveryLogService,
    useFactory: (repo: Repository<Entity>) => new DeliveryLogService(repo),
    inject: [getRepositoryToken(messageLogEntity)],
  };
}

export function createPlatformDeadLetterProvider(
  platform: Platform,
  deadLetterEntity: EntityClass,
): Provider {
  return {
    provide: PlatformDeadLetterService,
    useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
      new PlatformDeadLetterService(platform, repo),
    inject: [getRepositoryToken(deadLetterEntity)],
  };
}
