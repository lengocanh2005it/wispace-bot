import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  CrossPlatformRedisCleaner,
  REDIS_CLIENT,
  type RedisClientPort,
} from '@wispace/bot-common/redis';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    DiscordReportModule,
    DiscordChatModule,
    DiscordStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    WispaceModule,
  ],
  controllers: [DiscordOpsController],
  providers: [
    {
      provide: CrossPlatformRedisCleaner,
      useFactory: (redisClient: RedisClientPort) =>
        new CrossPlatformRedisCleaner(redisClient, 'discord'),
      inject: [REDIS_CLIENT],
    },
  ],
})
export class DiscordOpsModule {}
