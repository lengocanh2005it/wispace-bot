import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { ZaloOaTokenEntity } from '../../infrastructure/database/entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloLinkVerifyRecordEntity } from '../../infrastructure/database/entities/zalo-link-verify-record.entity';
import { ZaloTokenService } from './application/services/zalo-token.service';
import { ZaloTokenRefreshService } from './application/services/zalo-token-refresh.service';
import { ZaloOauthStateService } from './application/services/zalo-oauth-state.service';
import { ZaloAccountLinkService } from './application/services/zalo-account-link.service';
import { ZaloLinkCompletionService } from './application/services/zalo-link-completion.service';
import { ZaloLinkReconcileCronService } from './application/services/zalo-link-reconcile-cron.service';
import { TypeormZaloLinkVerifyRecordRepository } from './infrastructure/typeorm-zalo-link-verify-record.repository';
import { ZALO_LINK_VERIFY_RECORD_REPOSITORY } from './domain/ports/zalo-link-verify-record.repository.port';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
      ZaloLinkVerifyRecordEntity,
    ]),
    ZaloChatModule,
  ],
  controllers: [],
  providers: [
    ZaloTokenService,
    ZaloTokenRefreshService,
    ZaloOauthStateService,
    ZaloAccountLinkService,
    ZaloLinkCompletionService,
    ZaloLinkReconcileCronService,
    {
      provide: ZALO_LINK_VERIFY_RECORD_REPOSITORY,
      useClass: TypeormZaloLinkVerifyRecordRepository,
    },
    {
      provide: WispaceTokenVerifyService,
      useFactory: (configService: ConfigService) =>
        new WispaceTokenVerifyService(configService, 'zalo'),
      inject: [ConfigService],
    },
  ],
  exports: [
    ZaloTokenService,
    ZaloAccountLinkService,
    ZaloOauthStateService,
    ZaloLinkCompletionService,
    WispaceTokenVerifyService,
    ZALO_LINK_VERIFY_RECORD_REPOSITORY,
  ],
})
export class ZaloOauthModule {}
