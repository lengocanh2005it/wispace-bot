import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  CLARIFICATION_STATE_STORE,
  createClarificationStateStore,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { CommonModule } from '../../shared/common/common.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerMappingService } from './application/services/messenger-mapping.service';
import { MessengerLinkContextService } from './application/services/messenger-link-context.service';
import { MessengerLinkStartupService } from './application/services/messenger-link-startup.service';
import { MessengerLinkReconcileCronService } from './application/services/messenger-link-reconcile-cron.service';
import { WispaceMessengerTokenVerifyService } from './infrastructure/wispace/wispace-messenger-token-verify.service';
import { MessengerLinkVerifyRecordEntity } from '../../infrastructure/database/entities/messenger-link-verify-record.entity';
import { TypeormMessengerLinkVerifyRecordRepository } from './infrastructure/persistence/typeorm-messenger-link-verify-record.repository';
import { MESSENGER_LINK_VERIFY_RECORD_REPOSITORY } from './domain/ports/messenger-link-verify-record.repository.port';
import { PlatformLinkStateService } from '@wispace/database';
import {
  WispaceConfigService,
  WispaceLinkStatusClient,
} from '@wispace/wispace-client';

/**
 * Self-contained module for user linking flow:
 * link context resolution → mapping → token verify.
 *
 * Exports: MessengerMappingService, MessengerLinkContextService.
 */
@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    StudyReminderModule,
    TypeOrmModule.forFeature([MessengerLinkVerifyRecordEntity]),
  ],
  providers: [
    MessengerMappingService,
    MessengerLinkContextService,
    MessengerLinkStartupService,
    WispaceMessengerTokenVerifyService,
    MessengerLinkReconcileCronService,
    PlatformLinkStateService,
    {
      provide: WispaceLinkStatusClient,
      useFactory: (configService: ConfigService) => {
        const wispace = new WispaceConfigService((key) =>
          configService.get<string>(key),
        );
        return new WispaceLinkStatusClient(
          wispace.buildLinkStatusClientConfig('x-psid'),
        );
      },
      inject: [ConfigService],
    },
    {
      provide: MESSENGER_LINK_VERIFY_RECORD_REPOSITORY,
      useClass: TypeormMessengerLinkVerifyRecordRepository,
    },
    {
      provide: CLARIFICATION_STATE_STORE,
      useFactory: (
        configService: ConfigService,
        redisClient?: RedisClientPort,
      ): ClarificationStateStore =>
        createClarificationStateStore({
          platform: 'messenger',
          config: configService,
          redisClient,
        }),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
  ],
  exports: [
    MessengerMappingService,
    MessengerLinkContextService,
    CLARIFICATION_STATE_STORE,
  ],
})
export class UserLinkingModule {}
