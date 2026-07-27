import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BotMetricsService, type MetricsConfig } from '@wispace/bot-metrics';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

/**
 * Messenger-specific metrics service — extends shared BotMetricsService
 * with OTel tracing configured from @opentelemetry/api.
 */
@Injectable()
export class MetricsService
  extends BotMetricsService
  implements OnModuleDestroy
{
  constructor() {
    const otelTracer = trace.getTracer('messenger-ai-for-student');
    const config: MetricsConfig = {
      prefix: 'messenger',
      collectDefaults: true,
      tracer: otelTracer,
      spanStatusCode: SpanStatusCode,
      contextApi: context,
      traceApi: trace,
    };
    super(config);
  }
}
