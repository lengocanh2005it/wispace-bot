import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [BotCommonModule, ZaloReportModule, ZaloStudyReminderModule],
  controllers: [ZaloOpsController],
})
export class ZaloOpsModule {}
