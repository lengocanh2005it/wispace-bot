import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WispaceCalendarService,
  WispaceConfigService,
  PrecreateExerciseApiClient,
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
      provide: PrecreateExerciseApiClient,
      useFactory: (configService: WispaceConfigService) =>
        new PrecreateExerciseApiClient(
          configService.buildPrecreateExerciseClientConfig(),
        ),
      inject: [WispaceConfigService],
    },
  ],
  exports: [
    WispaceConfigService,
    WispaceGoalsService,
    WispaceCalendarService,
    PrecreateExerciseApiClient,
  ],
})
export class ZaloWispaceModule {}
