import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [BotCommonModule, DiscordReportModule, DiscordStudyReminderModule],
  controllers: [DiscordOpsController],
})
export class DiscordOpsModule {}
