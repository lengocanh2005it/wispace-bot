import { Module } from '@nestjs/common';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { MessengerReportDeliveryService } from './application/services/messenger-report-delivery.service';

@Module({
  imports: [MessengerOutboundModule, StudentReportModule],
  providers: [MessengerReportDeliveryService],
  exports: [MessengerReportDeliveryService],
})
export class MessengerReportModule {}
