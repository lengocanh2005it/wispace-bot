import { Module } from '@nestjs/common';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

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
    {
      provide: PlatformStudyCalendarCommandService,
      useFactory: (
        calendarService: WispaceCalendarService,
        configService: WispaceConfigService,
      ) =>
        new PlatformStudyCalendarCommandService(
          { platform: 'discord', enforceLeadTime: true },
          calendarService,
          configService,
        ),
      inject: [WispaceCalendarService, WispaceConfigService],
    },
  ],
  exports: [
    WispaceGoalsService,
    WispaceCalendarService,
    PlatformStudyCalendarCommandService,
  ],
})
export class WispaceModule {}
