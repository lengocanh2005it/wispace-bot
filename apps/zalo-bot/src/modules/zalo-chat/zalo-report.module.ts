import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import { ScheduledReportClaimEntity } from '../../infrastructure/database/entities/scheduled-report-claim.entity';
import { ZaloChatModule } from './zalo-chat.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloReportDeliveryService } from './application/services/zalo-report-delivery.service';
import { ZaloReportCronService } from './application/services/zalo-report-cron.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloAccountLinkEntity,
      ScheduledReportClaimEntity,
    ]),
    ZaloChatModule,
    ZaloWispaceModule,
  ],
  providers: [ZaloReportDeliveryService, ZaloReportCronService],
  exports: [ZaloReportCronService],
})
export class ZaloReportModule {}
