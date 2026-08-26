import { Module } from '@nestjs/common';
import {
  createWispaceProviders,
  WispaceCalendarService,
  WispaceConfigService,
  WispaceGoalsService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

@Module({
  providers: [
    ...createWispaceProviders({
      header: 'x-discordid',
      horizonHours: (configService) => () =>
        configService.getSyncHorizonHours(),
    }),
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
    PrecreateExerciseApiClient,
    WispaceConfigService,
    PlatformStudyCalendarCommandService,
  ],
})
export class WispaceModule {}
