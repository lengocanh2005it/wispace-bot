import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceExerciseService,
  WispaceGoalsService,
} from '@wispace/wispace-client';

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
        new WispaceGoalsService('x-zaloid', configService),
      inject: [WispaceConfigService],
    },
    {
      provide: WispaceCalendarService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceCalendarService('x-zaloid', configService),
      inject: [WispaceConfigService],
    },
    {
      provide: WispaceExerciseService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceExerciseService(
          'x-zaloid',
          configService.buildPrecreateExerciseClientConfig(),
        ),
      inject: [WispaceConfigService],
    },
  ],
  exports: [
    WispaceConfigService,
    WispaceGoalsService,
    WispaceCalendarService,
    WispaceExerciseService,
  ],
})
export class ZaloWispaceModule {}
