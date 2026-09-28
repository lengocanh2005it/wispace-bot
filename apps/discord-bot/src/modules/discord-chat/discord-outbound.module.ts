import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  DeliveryLogService,
} from '@wispace/database';
import {
  OUTBOUND_DELIVERY_JOURNAL,
  OUTBOUND_RATE_LIMIT,
  type OutboundDeliveryJournalPort,
} from '@wispace/contracts';
import { OutboundRateLimiter } from '@wispace/bot-common/redis';
import { DiscordOutboundService } from './application/services/discord-outbound.service';
import { DISCORD_TRANSPORT } from './application/ports/discord-transport.port';
import { DiscordSdkTransportAdapter } from './infrastructure/adapters/discord-sdk-transport.adapter';
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
      // Bound here because `DiscordOutboundService` is provided here — a token
      // bound in a module that does not provide its consumer resolves to
      // `undefined` and `@Optional()` swallows the error. The full account is
      // in `docs/architecture-boundaries.md`; see #1450.
      provide: OUTBOUND_RATE_LIMIT,
      useExisting: OutboundRateLimiter,
    },
    {
      provide: DeliveryLogService,
      useFactory: (repo: Repository<DiscordMessageLogEntity>) =>
        new DeliveryLogService(repo, 'discord'),
      inject: [getRepositoryToken(DiscordMessageLogEntity)],
    },
    {
      provide: PlatformDeadLetterService,
      useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
        new PlatformDeadLetterService('discord', repo),
      inject: [getRepositoryToken(WebhookDeadLetterEntity)],
    },
    {
      provide: OUTBOUND_DELIVERY_JOURNAL,
      useFactory: (
        deliveryLog: DeliveryLogService,
        deadLetter: PlatformDeadLetterService,
      ): OutboundDeliveryJournalPort => ({
        logDelivery: (input) => deliveryLog.logDelivery(input),
        saveDeadLetter: (input) => deadLetter.save(input),
      }),
      inject: [DeliveryLogService, PlatformDeadLetterService],
    },
    DiscordOutboundService,
    DiscordSdkTransportAdapter,
    {
      provide: DISCORD_TRANSPORT,
      useExisting: DiscordSdkTransportAdapter,
    },
  ],
  exports: [
    DiscordOutboundService,
    DISCORD_TRANSPORT,
    PlatformDeadLetterService,
    OUTBOUND_DELIVERY_JOURNAL,
  ],
})
export class DiscordOutboundModule {}
