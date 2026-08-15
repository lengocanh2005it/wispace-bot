import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { BotCommonModule } from '@wispace/bot-common';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordLinkVerifyRecordEntity } from '../../infrastructure/database/entities/discord-link-verify-record.entity';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { DiscordAccountLinkService } from './application/services/discord-account-link.service';
import { DiscordGuildMembershipService } from './application/services/discord-guild-membership.service';
import { DiscordLinkVerifyRecordService } from './application/services/discord-link-verify-record.service';
import { DiscordLinkReconcileCron } from './application/services/discord-link-reconcile-cron.service';
import { TypeormDiscordAccountLinkRepository } from './infrastructure/persistence/typeorm-discord-account-link.repository';
import { DISCORD_ACCOUNT_LINK_REPOSITORY } from './domain/ports/discord-account-link.repository.port';
import { DiscordOauthController } from './presentation/controllers/discord-oauth.controller';
import { DiscordLinkStatusController } from './presentation/controllers/discord-link-status.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscordAccountLinkEntity,
      DiscordLinkVerifyRecordEntity,
    ]),
    DiscordOutboundModule,
    BotCommonModule,
  ],
  controllers: [DiscordOauthController, DiscordLinkStatusController],
  providers: [
    {
      provide: WispaceTokenVerifyService,
      useFactory: (configService: ConfigService) =>
        new WispaceTokenVerifyService(configService, 'discord'),
      inject: [ConfigService],
    },
    DiscordAccountLinkService,
    DiscordGuildMembershipService,
    DiscordLinkVerifyRecordService,
    DiscordLinkReconcileCron,
    TypeormDiscordAccountLinkRepository,
    {
      provide: DISCORD_ACCOUNT_LINK_REPOSITORY,
      useExisting: TypeormDiscordAccountLinkRepository,
    },
  ],
  exports: [DiscordAccountLinkService],
})
export class AccountLinkModule {}
