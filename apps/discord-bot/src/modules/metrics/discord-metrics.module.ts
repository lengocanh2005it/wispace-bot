import { Global, Module } from '@nestjs/common';
import { BotMetricsService, type MetricsConfig } from '@wispace/bot-metrics';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { Injectable, OnModuleDestroy } from '@nestjs/common';

/**
 * Discord-specific metrics service — extends shared BotMetricsService
 * with OTel tracing configured from @opentelemetry/api.
 * DI-instantiated so Nest calls onModuleDestroy (registry.clear).
 */
@Injectable()
export class DiscordMetricsService
  extends BotMetricsService
  implements OnModuleDestroy
{
  constructor() {
    const config: MetricsConfig = {
      prefix: 'discord',
      collectDefaults: true,
      tracer: trace.getTracer('discord-bot'),
      spanStatusCode: SpanStatusCode,
      contextApi: context,
      traceApi: trace,
    };
    super(config);
  }
}

@Global()
@Module({
  providers: [DiscordMetricsService],
  exports: [DiscordMetricsService],
})
export class DiscordMetricsModule {}
