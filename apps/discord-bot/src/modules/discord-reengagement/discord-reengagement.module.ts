import { Module } from '@nestjs/common';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DiscordReengagementController } from './discord-reengagement.controller';
import { DiscordReengagementService } from './discord-reengagement.service';
import { DiscordReengagementCronService } from './discord-reengagement-cron.service';

/**
 * Re-engagement DM orchestration (#850/#853): WISPACE payload → proactive DM
 * → mark-sent. Deliberately does NOT depend on WebActivityService (#595) —
 * a dormant learner is a valid re-engagement recipient. The batch cron (#854)
 * is registered here and disabled unless REENGAGEMENT_ENABLED=true.
 */
@Module({
  imports: [
    BotCommonModule,
    DiscordOutboundModule,
    AccountLinkModule,
    WispaceModule,
    DatabaseModule,
  ],
  controllers: [DiscordReengagementController],
  providers: [DiscordReengagementService, DiscordReengagementCronService],
})
export class DiscordReengagementModule {}
