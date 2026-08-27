import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DopplerSyncModule } from '@wispace/doppler-sync';
import { PrivacyDataService } from '@wispace/database';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordChatModule } from '../discord-chat/discord-chat.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DiscordReportModule,
    DiscordChatModule,
    DiscordStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    WispaceModule,
    DopplerSyncModule.forPlatform('discord-bot'),
  ],
  controllers: [DiscordOpsController],
  providers: [PrivacyDataService],
})
export class DiscordOpsModule {}
