import { Module } from '@nestjs/common';
import { CommonModule } from '../../shared/common/common.module';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    CommonModule,
    DiscordChatModule,
    DiscordReportModule,
    DiscordStudyReminderModule,
  ],
  controllers: [DiscordOpsController],
})
export class DiscordOpsModule {}
