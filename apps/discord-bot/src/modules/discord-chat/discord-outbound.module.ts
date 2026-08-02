import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordOutboundService } from './application/services/discord-outbound.service';
import { DiscordDeliveryLogService } from './application/services/discord-delivery-log.service';
import { DiscordDeadLetterService } from './application/services/discord-dead-letter.service';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { WebhookDeadLetterEntity } from '@wispace/database';

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
    DiscordDeliveryLogService,
    DiscordDeadLetterService,
    DiscordOutboundService,
  ],
  exports: [DiscordOutboundService, DiscordDeadLetterService],
})
export class DiscordOutboundModule {}
