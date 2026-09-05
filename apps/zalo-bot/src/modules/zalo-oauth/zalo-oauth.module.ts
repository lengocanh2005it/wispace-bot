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
  WispaceLinkStatusClient,
  WispaceTokenVerifyService,
} from '@wispace/wispace-client';
import { PlatformLinkStateService } from '@wispace/database';
import { ZaloOaTokenEntity } from '../../infrastructure/database/entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloLinkVerifyRecordEntity } from '../../infrastructure/database/entities/zalo-link-verify-record.entity';
import { ZaloTokenService } from './application/services/zalo-token.service';
import { ZaloTokenRefreshService } from './application/services/zalo-token-refresh.service';
import { ZaloOauthStateService } from './application/services/zalo-oauth-state.service';
import { ZaloAccountLinkService } from './application/services/zalo-account-link.service';
import { ZaloLinkReconcileCronService } from './application/services/zalo-link-reconcile-cron.service';
import { TypeormZaloLinkVerifyRecordRepository } from './infrastructure/typeorm-zalo-link-verify-record.repository';
import { ZALO_LINK_VERIFY_RECORD_REPOSITORY } from './domain/ports/zalo-link-verify-record.repository.port';
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
    ZaloLinkReconcileCronService,
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
    ZaloAccountLinkService,
    PlatformLinkStateService,
    ZaloOauthStateService,
    WispaceTokenVerifyService,
    ZALO_LINK_VERIFY_RECORD_REPOSITORY,
    CLARIFICATION_STATE_STORE,
  ],
})
export class ZaloOauthModule {}
