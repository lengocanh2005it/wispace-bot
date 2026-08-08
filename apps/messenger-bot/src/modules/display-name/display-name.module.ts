import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  REDIS_CLIENT,
  RedisUserDisplayNameCache,
  type RedisClientPort,
} from '@wispace/bot-common';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import { CommonModule } from '../../shared/common/common.module';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { UserDisplayNameService } from './application/user-display-name.service';
import { USER_DISPLAY_NAME_CACHE } from './domain/user-display-name-cache.port';

/**
 * Resolves WISPACE user display names from the users table,
 * with optional Redis caching. Used by the chat pipeline and
 * webhook action executor — decoupled from study-reminder.
 */
@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    TypeOrmModule.forFeature([UserEntity]),
  ],
  providers: [
    UserDisplayNameService,
    {
      provide: RedisUserDisplayNameCache,
      useFactory: (
        redisClient: RedisClientPort,
        configService: ConfigService,
      ) =>
        new RedisUserDisplayNameCache(redisClient, configService, {
          platform: 'messenger',
        }),
      inject: [REDIS_CLIENT, ConfigService],
    },
    {
      provide: USER_DISPLAY_NAME_CACHE,
      useExisting: RedisUserDisplayNameCache,
    },
  ],
  exports: [UserDisplayNameService],
})
export class DisplayNameModule {}
