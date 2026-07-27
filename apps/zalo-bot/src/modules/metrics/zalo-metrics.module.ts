import { Global, Module } from '@nestjs/common';
import { BotMetricsService } from '@wispace/bot-metrics';

const metricsService = new BotMetricsService({
  prefix: 'zalo',
  collectDefaults: true,
});

@Global()
@Module({
  providers: [
    {
      provide: BotMetricsService,
      useValue: metricsService,
    },
  ],
  exports: [BotMetricsService],
})
export class ZaloMetricsModule {}
