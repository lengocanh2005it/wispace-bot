import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { DiscordAccountLinkService } from './application/services/discord-account-link.service';
import { DiscordGuildMembershipService } from './application/services/discord-guild-membership.service';
import { DiscordPendingJoinService } from './application/services/discord-pending-join.service';
import { DiscordOauthController } from './presentation/controllers/discord-oauth.controller';
import { DiscordGuildController } from './presentation/controllers/discord-guild.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([DiscordAccountLinkEntity]),
    DiscordOutboundModule,
  ],
  controllers: [DiscordOauthController, DiscordGuildController],
  providers: [
    {
      provide: WispaceTokenVerifyService,
      useFactory: (configService: ConfigService) =>
        new WispaceTokenVerifyService(configService, 'discord'),
      inject: [ConfigService],
    },
    DiscordAccountLinkService,
    DiscordGuildMembershipService,
    DiscordPendingJoinService,
  ],
  exports: [DiscordAccountLinkService, DiscordPendingJoinService],
})
export class AccountLinkModule {}
