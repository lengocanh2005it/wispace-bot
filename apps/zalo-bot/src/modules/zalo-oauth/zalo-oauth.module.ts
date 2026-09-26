import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  CLARIFICATION_STATE_STORE,
  createClarificationStateStore,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import {
  WispaceConfigService,
  WispaceTokenVerifyService,
} from '@wispace/wispace-client/adapters';
import { WispaceLinkStatusClient } from '@wispace/wispace-client/core';
import { PLATFORM_LINK_STATE } from '@wispace/account-link-core/core';
import { PlatformLinkStateService } from '@wispace/database';
import {
  ZALO_LINK_STATE,
  ZALO_TOKEN_VERIFY,
} from './domain/ports/zalo-link-state.port';
import {
  ZaloLinkStateAdapter,
  ZaloTokenVerifyAdapter,
} from './infrastructure/adapters/zalo-link-state.adapter';
import { ZaloOaTokenEntity } from '../../infrastructure/database/entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloLinkVerifyRecordEntity } from '../../infrastructure/database/entities/zalo-link-verify-record.entity';
import { ZaloWelcomeRecordEntity } from '../../infrastructure/database/entities/zalo-welcome-record.entity';
import { ZaloTokenService } from './application/services/zalo-token.service';
import { ZaloTokenRefreshService } from './application/services/zalo-token-refresh.service';
import { ZaloOauthStateService } from './application/services/zalo-oauth-state.service';
import { ZaloAccountLinkService } from './infrastructure/persistence/zalo-account-link.service';
import { ZALO_ACCOUNT_LINK } from './domain/ports/zalo-account-link.port';
import { TypeormZaloLinkVerifyRecordRepository } from './infrastructure/typeorm-zalo-link-verify-record.repository';
import { TypeormZaloWelcomeRecordRepository } from './infrastructure/typeorm-zalo-welcome-record.repository';
import { ZALO_LINK_VERIFY_RECORD_REPOSITORY } from './domain/ports/zalo-link-verify-record.repository.port';
import { ZALO_WELCOME_RECORD_REPOSITORY } from './domain/ports/zalo-welcome-record.repository.port';
import { ZALO_OAUTH_CLIENT } from './application/ports/zalo-oauth-client.port';
import {
  ZALO_OA_ACCESS_TOKEN,
  ZALO_OA_TOKEN_STORE,
} from './application/ports/zalo-oa-token-store.port';
import { ZALO_OAUTH_STATE_STORE } from './application/ports/zalo-oauth-state-store.port';
import { ZaloOAuthHttpAdapter } from './infrastructure/adapters/zalo-oauth-http.adapter';
import { TypeormZaloOaTokenStoreAdapter } from './infrastructure/adapters/typeorm-zalo-oa-token-store.adapter';
import { TypeormZaloOauthStateStoreAdapter } from './infrastructure/adapters/typeorm-zalo-oauth-state-store.adapter';
import {
  PLATFORM_CONNECTIVITY,
  PlatformConnectivityState,
} from '@wispace/bot-common/health';
import { BotMetricsService } from '@wispace/bot-metrics';

@Module({
  imports: [
    BotCommonModule,
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
      ZaloLinkVerifyRecordEntity,
      ZaloWelcomeRecordEntity,
    ]),
  ],
  controllers: [],
  providers: [
    {
      provide: PlatformConnectivityState,
      useFactory: (metrics: BotMetricsService) =>
        new PlatformConnectivityState('zalo', ({ previous, current }) =>
          metrics.setPlatformConnectivity(previous, current),
        ),
      inject: [BotMetricsService],
    },
    {
      provide: PLATFORM_CONNECTIVITY,
      useExisting: PlatformConnectivityState,
    },
    ZaloTokenService,
    ZaloTokenRefreshService,
    ZaloOauthStateService,
    ZaloAccountLinkService,
    {
      provide: ZALO_ACCOUNT_LINK,
      useExisting: ZaloAccountLinkService,
    },
    ZaloOAuthHttpAdapter,
    TypeormZaloOaTokenStoreAdapter,
    TypeormZaloOauthStateStoreAdapter,
    TypeormZaloWelcomeRecordRepository,
    {
      provide: ZALO_OAUTH_CLIENT,
      useExisting: ZaloOAuthHttpAdapter,
    },
    {
      provide: ZALO_OA_TOKEN_STORE,
      useExisting: TypeormZaloOaTokenStoreAdapter,
    },
    {
      provide: ZALO_OAUTH_STATE_STORE,
      useExisting: TypeormZaloOauthStateStoreAdapter,
    },
    {
      provide: ZALO_OA_ACCESS_TOKEN,
      useExisting: ZaloTokenService,
    },
    PlatformLinkStateService,
    ZaloTokenVerifyAdapter,
    {
      provide: ZALO_TOKEN_VERIFY,
      useExisting: ZaloTokenVerifyAdapter,
    },
    ZaloLinkStateAdapter,
    {
      provide: ZALO_LINK_STATE,
      useExisting: ZaloLinkStateAdapter,
    },
    {
      provide: PLATFORM_LINK_STATE,
      useExisting: PlatformLinkStateService,
    },
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
          wispace.buildLinkStatusClientConfig('x-zaloid'),
        );
      },
      inject: [ConfigService, BotMetricsService],
    },
    {
      provide: ZALO_LINK_VERIFY_RECORD_REPOSITORY,
      useClass: TypeormZaloLinkVerifyRecordRepository,
    },
    {
      provide: ZALO_WELCOME_RECORD_REPOSITORY,
      useExisting: TypeormZaloWelcomeRecordRepository,
    },
    {
      provide: WispaceTokenVerifyService,
      useFactory: (configService: ConfigService, metrics: BotMetricsService) =>
        new WispaceTokenVerifyService(configService, 'zalo', metrics),
      inject: [ConfigService, BotMetricsService],
    },
    {
      provide: CLARIFICATION_STATE_STORE,
      useFactory: (
        configService: ConfigService,
        redisClient?: RedisClientPort,
      ): ClarificationStateStore =>
        createClarificationStateStore({
          platform: 'zalo',
          config: configService,
          redisClient,
        }),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
  ],
  exports: [
    PLATFORM_CONNECTIVITY,
    PlatformConnectivityState,
    ZaloTokenService,
    ZALO_OA_ACCESS_TOKEN,
    ZALO_OAUTH_CLIENT,
    ZaloAccountLinkService,
    ZALO_ACCOUNT_LINK,
    PlatformLinkStateService,
    ZALO_LINK_STATE,
    ZALO_TOKEN_VERIFY,
    PLATFORM_LINK_STATE,
    ZaloOauthStateService,
    WispaceTokenVerifyService,
    ZALO_LINK_VERIFY_RECORD_REPOSITORY,
    ZALO_WELCOME_RECORD_REPOSITORY,
    CLARIFICATION_STATE_STORE,
  ],
})
export class ZaloOauthModule {}
