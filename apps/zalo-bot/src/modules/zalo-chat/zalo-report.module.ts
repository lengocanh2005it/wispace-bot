import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { join } from 'path';
import { createPlatformStudentReportServiceProvider } from '@wispace/student-report';
import { ChatMeteringModule } from '@wispace/chat-metering';
import { REPORT_CLAIM_REPOSITORY } from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import {
  ScheduledReportClaimEntity,
  PlatformReportClaimRepository,
} from '@wispace/database';
import { ZaloChatModule } from './zalo-chat.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloReportCronService } from './infrastructure/persistence/zalo-report-cron.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloAccountLinkEntity,
      ScheduledReportClaimEntity,
    ]),
    ZaloChatModule,
    ZaloWispaceModule,
    ChatMeteringModule.forPlatform('zalo'),
  ],
  providers: [
    ZaloReportCronService,
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useFactory: (repo: Repository<ScheduledReportClaimEntity>) =>
        new PlatformReportClaimRepository('zalo', repo),
      inject: [getRepositoryToken(ScheduledReportClaimEntity)],
    },
    createPlatformStudentReportServiceProvider({
      platform: 'zalo',
      promptDir: join(__dirname, '../../shared/prompts'),
    }),
  ],
  exports: [ZaloReportCronService],
})
export class ZaloReportModule {}
