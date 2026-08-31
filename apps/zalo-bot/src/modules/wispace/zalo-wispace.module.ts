import { Module } from '@nestjs/common';
import {
  createWispaceProviders,
  WispaceConfigService,
  WispaceDataCache,
  WispaceGoalsService,
  WispaceCalendarService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client';

@Module({
  providers: createWispaceProviders({ header: 'x-zaloid' }),
  exports: [
    WispaceConfigService,
    WispaceGoalsService,
    WispaceCalendarService,
    PrecreateExerciseApiClient,
    WispaceDataCache,
  ],
})
export class ZaloWispaceModule {}
