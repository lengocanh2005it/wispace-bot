import { Module } from '@nestjs/common';
import {
  createWispaceProviders,
  WispaceConfigService,
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
  ],
})
export class ZaloWispaceModule {}
