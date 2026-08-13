import { Module } from '@nestjs/common';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceExerciseService,
  WispaceGoalsService,
} from '@wispace/wispace-client';

@Module({
  providers: [
    WispaceConfigService,
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
        new WispaceExerciseService('x-zaloid', configService),
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
