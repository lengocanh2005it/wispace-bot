import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloChatModule } from '../zalo-chat/zalo-chat.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ZaloReportModule,
    ZaloChatModule,
    ZaloStudyReminderModule,
    // Authoritative session source for direct sync entry points (#111).
    ZaloWispaceModule,
  ],
  controllers: [ZaloOpsController],
})
export class ZaloOpsModule {}
