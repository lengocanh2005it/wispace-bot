import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { ZaloOaTokenEntity } from '../../infrastructure/database/entities/zalo-oa-token.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloTokenService } from './application/services/zalo-token.service';
import { ZaloTokenRefreshService } from './application/services/zalo-token-refresh.service';
import { ZaloOauthStateService } from './application/services/zalo-oauth-state.service';
import { ZaloAccountLinkService } from './application/services/zalo-account-link.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloOaTokenEntity,
      ZaloOauthStateEntity,
      ZaloAccountLinkEntity,
    ]),
  ],
  controllers: [],
  providers: [
    ZaloTokenService,
    ZaloTokenRefreshService,
    ZaloOauthStateService,
    ZaloAccountLinkService,
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
    WispaceTokenVerifyService,
  ],
})
export class ZaloOauthModule {}
