import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WispaceCalendarService,
  WispaceConfigService,
  PrecreateExerciseApiClient,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';

@Module({
  providers: [
    {
      provide: WispaceConfigService,
      useFactory: (configService: ConfigService) =>
        new WispaceConfigService((key) => configService.get<string>(key)),
      inject: [ConfigService],
    },
    {
      provide: WispaceGoalsService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceGoalsService('x-discordid', configService),
      inject: [WispaceConfigService],
    },
    {
      provide: PrecreateExerciseApiClient,
      useFactory: (configService: WispaceConfigService) =>
        new PrecreateExerciseApiClient(
          configService.buildPrecreateExerciseClientConfig(),
        ),
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
    PrecreateExerciseApiClient,
    PlatformStudyCalendarCommandService,
  ],
})
export class WispaceModule {}
