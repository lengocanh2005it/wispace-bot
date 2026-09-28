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
      // #1450: `DiscordOutboundService` is provided HERE, so the token that
      // service injects has to be bound here too. Binding it in
      // `DiscordChatModule` — which this module does not import, and which
      // does not export it — left the injection resolving to `undefined`,
      // because `@Optional()` swallows the `UnknownDependenciesException`. The
      // effect was silent: `if (!this.outboundRateLimiter) return true` admits
      // every send. A token has none of the app-wide visibility a class had
      // through the `@Global()` RedisModule.
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
