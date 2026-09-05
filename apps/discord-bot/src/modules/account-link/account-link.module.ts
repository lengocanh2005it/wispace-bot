import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  WispaceConfigService,
  WispaceLinkStatusClient,
  WispaceTokenVerifyService,
} from '@wispace/wispace-client';
import { PlatformLinkStateService } from '@wispace/database';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  CLARIFICATION_STATE_STORE,
  createClarificationStateStore,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordLinkVerifyRecordEntity } from '../../infrastructure/database/entities/discord-link-verify-record.entity';
import { DiscordWelcomeRecordEntity } from '../../infrastructure/database/entities/discord-welcome-record.entity';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { DiscordAccountLinkService } from './application/services/discord-account-link.service';
import { DiscordLinkCompletionService } from './application/services/discord-link-completion.service';
import { DiscordLinkReconcileCronService } from './application/services/discord-link-reconcile-cron.service';
import { DiscordRelinkNotifier } from './application/services/discord-relink-notifier.service';
import { DiscordWelcomeService } from './application/services/discord-welcome.service';
import { TypeormDiscordAccountLinkRepository } from './infrastructure/persistence/typeorm-discord-account-link.repository';
import { TypeormDiscordLinkVerifyRecordRepository } from './infrastructure/persistence/typeorm-discord-link-verify-record.repository';
import { TypeormDiscordWelcomeRecordRepository } from './infrastructure/persistence/typeorm-discord-welcome-record.repository';
import { TypeormDiscordOauthStateRepository } from './infrastructure/persistence/typeorm-discord-oauth-state.repository';
import { DiscordOauthHttpExchange } from './infrastructure/discord-oauth-http.exchange';
import { DiscordGuildMembershipAdapter } from './infrastructure/adapters/discord-guild-membership.adapter';
import { DISCORD_ACCOUNT_LINK_REPOSITORY } from './domain/ports/discord-account-link.repository.port';
import { DISCORD_LINK_VERIFY_RECORD_REPOSITORY } from './domain/ports/discord-link-verify-record.repository.port';
import { DISCORD_WELCOME_RECORD_REPOSITORY } from './domain/ports/discord-welcome-record.repository.port';
import { DISCORD_OAUTH_STATE_REPOSITORY } from './domain/ports/discord-oauth-state.repository.port';
import { DISCORD_OAUTH_EXCHANGE } from './domain/ports/discord-oauth-exchange.port';
import { DISCORD_GUILD_MEMBERSHIP } from './domain/ports/discord-guild-membership.port';
import { DiscordOauthController } from './presentation/controllers/discord-oauth.controller';
import { DiscordLinkStatusController } from './presentation/controllers/discord-link-status.controller';
import { DiscordOauthStateEntity } from '../../infrastructure/database/entities/discord-oauth-state.entity';
import { DiscordOauthStateService } from './application/services/discord-oauth-state.service';
import { BotMetricsService } from '@wispace/bot-metrics';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscordAccountLinkEntity,
      DiscordLinkVerifyRecordEntity,
      DiscordWelcomeRecordEntity,
      DiscordOauthStateEntity,
    ]),
    DiscordOutboundModule,
    BotCommonModule,
  ],
  controllers: [DiscordOauthController, DiscordLinkStatusController],
  providers: [
    {
      provide: WispaceTokenVerifyService,
      useFactory: (configService: ConfigService, metrics: BotMetricsService) =>
        new WispaceTokenVerifyService(configService, 'discord', metrics),
      inject: [ConfigService, BotMetricsService],
    },
    DiscordAccountLinkService,
    DiscordLinkCompletionService,
    DiscordLinkReconcileCronService,
    PlatformLinkStateService,
    {
      provide: WispaceLinkStatusClient,
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
      ) => {
        const wispace = new WispaceConfigService(
          (key) => configService.get<string>(key),
          metrics,
        );
        return new WispaceLinkStatusClient(
          wispace.buildLinkStatusClientConfig('x-discordid'),
        );
      },
      inject: [ConfigService, BotMetricsService],
    },
    DiscordRelinkNotifier,
    DiscordWelcomeService,
    DiscordOauthStateService,
    TypeormDiscordAccountLinkRepository,
    TypeormDiscordLinkVerifyRecordRepository,
    TypeormDiscordWelcomeRecordRepository,
    TypeormDiscordOauthStateRepository,
    DiscordOauthHttpExchange,
    DiscordGuildMembershipAdapter,
    {
      provide: DISCORD_ACCOUNT_LINK_REPOSITORY,
      useExisting: TypeormDiscordAccountLinkRepository,
    },
    {
      provide: DISCORD_LINK_VERIFY_RECORD_REPOSITORY,
      useExisting: TypeormDiscordLinkVerifyRecordRepository,
    },
    {
      provide: DISCORD_WELCOME_RECORD_REPOSITORY,
      useExisting: TypeormDiscordWelcomeRecordRepository,
    },
    {
      provide: DISCORD_OAUTH_STATE_REPOSITORY,
      useExisting: TypeormDiscordOauthStateRepository,
    },
    {
      provide: DISCORD_OAUTH_EXCHANGE,
      useExisting: DiscordOauthHttpExchange,
    },
    {
      provide: DISCORD_GUILD_MEMBERSHIP,
      useExisting: DiscordGuildMembershipAdapter,
    },
    {
      provide: CLARIFICATION_STATE_STORE,
      useFactory: (
        configService: ConfigService,
        redisClient?: RedisClientPort,
      ): ClarificationStateStore =>
        createClarificationStateStore({
          platform: 'discord',
          config: configService,
          redisClient,
        }),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
  ],
  exports: [
    DiscordAccountLinkService,
    DiscordWelcomeService,
    DISCORD_LINK_VERIFY_RECORD_REPOSITORY,
    CLARIFICATION_STATE_STORE,
  ],
})
export class AccountLinkModule {}
