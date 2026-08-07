import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  createDeliveryLogProvider,
  createPlatformDeadLetterProvider,
} from '@wispace/database';
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
    createDeliveryLogProvider(DiscordMessageLogEntity),
    createPlatformDeadLetterProvider('discord', WebhookDeadLetterEntity),
    DiscordOutboundService,
  ],
  exports: [DiscordOutboundService, PlatformDeadLetterService],
})
export class DiscordOutboundModule {}
