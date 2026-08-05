import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  DeliveryLogService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
} from '@wispace/database';
import { Repository } from 'typeorm';
import { DiscordOutboundService } from './application/services/discord-outbound.service';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';

/**
 * Split out from `DiscordChatModule` so `AccountLinkModule` (OAuth callback,
 * which sends a welcome DM) can depend on `DiscordOutboundService` without a
 * circular import — `DiscordChatModule` also needs `AccountLinkModule` (to
 * resolve `discordUserId -> WISPACE userId` per message).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscordMessageLogEntity,
      WebhookDeadLetterEntity,
    ]),
  ],
  providers: [
    {
      provide: DeliveryLogService,
      useFactory: (repo: Repository<DiscordMessageLogEntity>) =>
        new DeliveryLogService(repo),
      inject: [getRepositoryToken(DiscordMessageLogEntity)],
    },
    {
      provide: PlatformDeadLetterService,
      useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
        new PlatformDeadLetterService('discord', repo),
      inject: [getRepositoryToken(WebhookDeadLetterEntity)],
    },
    DiscordOutboundService,
  ],
  exports: [DiscordOutboundService, PlatformDeadLetterService],
})
export class DiscordOutboundModule {}
