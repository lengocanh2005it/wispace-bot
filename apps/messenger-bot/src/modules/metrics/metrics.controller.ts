import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@UseGuards(InternalApiKeyGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@Res() res: Response): Promise<void> {
    const data = await this.metrics.getMetrics();
    res.setHeader('Content-Type', this.metrics.contentType());
    res.end(data);
  }
}
