import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { IntentsBitField, Partials } from 'discord.js';
import { NecordModule } from 'necord';
import { DatabaseModule } from './infrastructure/database/database.module';
import { RedisModule } from '@wispace/bot-common';
import { DiscordChatModule } from './modules/discord-chat/discord-chat.module';
import { DiscordStudyReminderModule } from './modules/discord-study-reminder/discord-study-reminder.module';
import { DiscordOpsModule } from './modules/discord-ops/discord-ops.module';
import { createMetricsModule } from '@wispace/bot-metrics';
import { HealthController } from '@wispace/bot-common';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env.shared'],
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 20 }],
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
    RedisModule,
    DiscordChatModule,
    DiscordStudyReminderModule,
    DiscordOpsModule,
    createMetricsModule('discord', 'discord-bot'),
  ],
})
export class AppModule {}
