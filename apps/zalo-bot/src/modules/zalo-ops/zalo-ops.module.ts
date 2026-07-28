import { Module } from '@nestjs/common';
import { CommonModule } from '../../shared/common/common.module';
import { ZaloReportModule } from '../zalo-chat/zalo-report.module';
import { ZaloStudyReminderModule } from '../zalo-study-reminder/zalo-study-reminder.module';
import { ZaloOpsController } from './zalo-ops.controller';

@Module({
  imports: [CommonModule, ZaloReportModule, ZaloStudyReminderModule],
  controllers: [ZaloOpsController],
})
export class ZaloOpsModule {}
