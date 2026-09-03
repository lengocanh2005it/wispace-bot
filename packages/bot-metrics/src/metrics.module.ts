import {
  Controller,
  DynamicModule,
  Get,
  Global,
  Header,
  Inject,
  Module,
  Res,
  UseGuards,
} from '@nestjs/common';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { Response } from 'express';
import {
  InternalApiKeyGuard,
  INTERNAL_AUTH_METRICS_PORT,
} from '@wispace/bot-common/guard';
import { BotMetricsService } from './bot-metrics.service';

/**
 * Factory for a global, platform-scoped metrics module (Messenger/Discord/
 * Zalo). Each platform gets a DI-instantiated subclass of BotMetricsService
 * so Nest calls `onModuleDestroy()` (registry.clear()) on shutdown.
 */
export function createMetricsModule(
  prefix: string,
  tracerName: string,
): DynamicModule {
  const PlatformMetricsService = class PlatformMetricsService extends BotMetricsService {
    constructor() {
      super({
        prefix,
        collectDefaults: true,
        tracer: trace.getTracer(tracerName),
        spanStatusCode: SpanStatusCode,
        contextApi: context,
        traceApi: trace,
      });
    }
  };

  @Controller('metrics')
  @UseGuards(InternalApiKeyGuard)
  class PlatformMetricsController {
    constructor(
      @Inject(PlatformMetricsService)
      private readonly metrics: InstanceType<typeof PlatformMetricsService>,
    ) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    async get(@Res() res: Response): Promise<void> {
      const data = await this.metrics.getMetrics();
      res.setHeader('Content-Type', this.metrics.contentType());
      res.end(data);
    }
  }

  @Global()
  @Module({
    controllers: [PlatformMetricsController],
    // useFactory so Nest does not try to resolve the (phantom) constructor
    // paramtypes that SWC emits for this class expression.
    providers: [
      {
        provide: PlatformMetricsService,
        useFactory: () => new PlatformMetricsService(),
      },
      // Expose the base token so services can inject BotMetricsService
      // without importing the platform-specific subclass.
      {
        provide: BotMetricsService,
        useExisting: PlatformMetricsService,
      },
      // InternalApiKeyGuard (bot-common) reports 401 rejections through this
      // port — bot-common cannot depend on bot-metrics directly.
      {
        provide: INTERNAL_AUTH_METRICS_PORT,
        useFactory: (metrics: InstanceType<typeof PlatformMetricsService>) => ({
          incRejected: () => metrics.incInternalAuthRejected(),
        }),
        inject: [PlatformMetricsService],
      },
    ],
    exports: [
      PlatformMetricsService,
      BotMetricsService,
      INTERNAL_AUTH_METRICS_PORT,
    ],
  })
  class PlatformMetricsModule {}

  return PlatformMetricsModule as unknown as DynamicModule;
}
