import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  CrossPlatformRedisCleaner,
  REDIS_CLIENT,
  type RedisClientPort,
} from '@wispace/bot-common/redis';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ZaloReportModule,
    ZaloChatModule,
    ZaloStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    ZaloWispaceModule,
  ],
  controllers: [ZaloOpsController],
  providers: [
    {
      provide: CrossPlatformRedisCleaner,
      useFactory: (redisClient: RedisClientPort) =>
        new CrossPlatformRedisCleaner(redisClient, 'zalo'),
      inject: [REDIS_CLIENT],
    },
  ],
})
export class ZaloOpsModule {}
