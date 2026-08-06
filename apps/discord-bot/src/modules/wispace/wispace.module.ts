import { Module } from '@nestjs/common';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { DiscordStudyCalendarCommandService } from './application/services/discord-study-calendar-command.service';

@Module({
  providers: [
    WispaceConfigService,
    {
      provide: WispaceGoalsService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceGoalsService('x-discordid', configService),
      inject: [WispaceConfigService],
    },
    {
      provide: WispaceCalendarService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceCalendarService('x-discordid', configService, () =>
          configService.getSyncHorizonHours(),
        ),
      inject: [WispaceConfigService],
    },
    DiscordStudyCalendarCommandService,
  ],
  exports: [
    WispaceGoalsService,
    WispaceCalendarService,
    DiscordStudyCalendarCommandService,
  ],
})
export class WispaceModule {}
