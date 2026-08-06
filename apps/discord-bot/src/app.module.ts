import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
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
      // Own .env wins; falls back to root .env.shared for cross-bot vars
      // (WISPACE_INTERNAL_KEY, OPENAI_*, DB_*...) — see .env.shared.example.
      // Missing files are silently skipped, so this is a no-op when the
      // shared file doesn't exist (e.g. production containers).
      envFilePath: ['.env', '../../.env.shared'],
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
