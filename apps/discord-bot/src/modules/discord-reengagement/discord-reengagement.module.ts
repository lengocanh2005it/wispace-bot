import { Module } from '@nestjs/common';
import { DiscordOutboundModule } from '../discord-chat/discord-outbound.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { DiscordReengagementController } from './discord-reengagement.controller';
import { DiscordReengagementService } from './discord-reengagement.service';

/**
 * Re-engagement DM orchestration (#850/#853): WISPACE payload → proactive DM
 * → mark-sent. Deliberately does NOT depend on WebActivityService (#595) —
 * a dormant learner is a valid re-engagement recipient.
 */
@Module({
  imports: [DiscordOutboundModule, AccountLinkModule, WispaceModule],
  controllers: [DiscordReengagementController],
  providers: [DiscordReengagementService],
})
export class DiscordReengagementModule {}
