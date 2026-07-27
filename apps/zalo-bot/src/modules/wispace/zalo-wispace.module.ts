import { Module } from '@nestjs/common';
import { ZaloWispaceConfigService } from './application/services/zalo-wispace-config.service';
import { ZaloWispaceGoalsService } from './application/services/zalo-wispace-goals.service';
import { ZaloWispaceCalendarService } from './application/services/zalo-wispace-calendar.service';

@Module({
  providers: [
    ZaloWispaceConfigService,
    ZaloWispaceGoalsService,
    ZaloWispaceCalendarService,
  ],
  exports: [ZaloWispaceGoalsService, ZaloWispaceCalendarService],
})
export class ZaloWispaceModule {}
