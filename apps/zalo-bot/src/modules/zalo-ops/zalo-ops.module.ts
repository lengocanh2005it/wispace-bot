import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { PrivacyDataService } from '@wispace/database';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    ZaloReportModule,
    ZaloChatModule,
    ZaloStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    ZaloWispaceModule,
  ],
  controllers: [ZaloOpsController],
  providers: [PrivacyDataService],
})
export class ZaloOpsModule {}
