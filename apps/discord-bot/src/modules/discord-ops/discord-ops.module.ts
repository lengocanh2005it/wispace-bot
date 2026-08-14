import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { DopplerSyncModule } from '@wispace/doppler-sync';
import { DiscordReportModule } from '../discord-chat/discord-report.module';
import { DiscordStudyReminderModule } from '../discord-study-reminder/discord-study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordOpsController } from './discord-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DiscordReportModule,
    DiscordStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    WispaceModule,
    DopplerSyncModule.forPlatform('discord-bot'),
  ],
  controllers: [DiscordOpsController],
})
export class DiscordOpsModule {}
