import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { IntentsBitField, Partials } from 'discord.js';
import { NecordModule } from 'necord';
import { DatabaseModule } from './infrastructure/database/database.module';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  createBotThrottlerOptions,
  RedisModule,
  RedisService,
} from '@wispace/bot-common/redis';
import { DiscordChatModule } from './modules/discord-chat/discord-chat.module';
import { DiscordStudyReminderModule } from './modules/discord-study-reminder/discord-study-reminder.module';
import { DiscordOpsModule } from './modules/discord-ops/discord-ops.module';
import { createMetricsModule } from '@wispace/bot-metrics';
import { HealthController } from '@wispace/bot-common/health';
import { OpsHealthModule } from '@wispace/ops-health';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (configService: ConfigService, redisService: RedisService) =>
        createBotThrottlerOptions(configService, redisService),
    }),
    NecordModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        token: configService.getOrThrow<string>('DISCORD_BOT_TOKEN'),
        intents: [
          IntentsBitField.Flags.Guilds,
          IntentsBitField.Flags.GuildMembers,
          IntentsBitField.Flags.DirectMessages,
          IntentsBitField.Flags.MessageContent,
        ],
        partials: [Partials.Channel],
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    BotCommonModule,
    RedisModule,
    DiscordChatModule,
    DiscordStudyReminderModule,
    DiscordOpsModule,
    createMetricsModule('discord', 'discord-bot'),
    OpsHealthModule.forPlatform('discord', DiscordChatModule),
  ],
  providers: [
    {
      provide: 'INTERNAL_API_KEY_VALIDATION',
      useFactory: (config: ConfigService) => {
        config.getOrThrow<string>('INTERNAL_API_KEY');
        return true;
      },
      inject: [ConfigService],
    },
  ],
})
export class AppModule {}
