import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common';
import { DopplerSyncModule } from '@wispace/doppler-sync';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [
    BotCommonModule,
    ZaloReportModule,
    ZaloStudyReminderModule,
    DopplerSyncModule.forPlatform('zalo-bot'),
  ],
  controllers: [ZaloOpsController],
})
export class ZaloOpsModule {}
