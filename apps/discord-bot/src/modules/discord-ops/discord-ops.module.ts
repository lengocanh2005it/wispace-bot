import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DiscordChatModule,
    DiscordReportModule,
    DiscordStudyReminderModule,
  ],
  controllers: [DiscordOpsController],
})
export class DiscordOpsModule {}
