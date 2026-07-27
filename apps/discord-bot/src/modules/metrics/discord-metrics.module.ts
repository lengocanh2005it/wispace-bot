import { Global, Module } from '@nestjs/common';
import { BotMetricsService } from '@wispace/bot-metrics';

const metricsService = new BotMetricsService({
  prefix: 'discord',
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
export class DiscordMetricsModule {}
