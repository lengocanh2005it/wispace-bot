import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { Response } from 'express';

@Controller('metrics')
@UseGuards(InternalApiKeyGuard)
export class ZaloMetricsController {
  constructor(private readonly metrics: BotMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Res() res: Response): Promise<void> {
    const data = await this.metrics.getMetrics();
    res.setHeader('Content-Type', this.metrics.contentType());
    res.end(data);
  }
}
