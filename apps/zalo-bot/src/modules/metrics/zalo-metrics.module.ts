import { Global, Module } from '@nestjs/common';
import { BotMetricsService } from '@wispace/bot-metrics';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

const metricsService = new BotMetricsService({
  prefix: 'zalo',
  collectDefaults: true,
  tracer: trace.getTracer('zalo-bot'),
  spanStatusCode: SpanStatusCode,
  contextApi: context,
  traceApi: trace,
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
