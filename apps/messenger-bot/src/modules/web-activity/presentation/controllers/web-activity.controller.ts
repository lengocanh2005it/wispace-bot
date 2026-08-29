import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { BotMetricsService } from '@wispace/bot-metrics';
import { WebActivityService } from '@wispace/database';
import { RecordWebActivityBody } from '../dto/web-activity.dto';

/**
 * WISPACE pushes here on each learner web-app visit. Auth reuses the ops
 * INTERNAL_API_KEY scheme. The upsert is idempotent + order-independent, so
 * there is no idempotency key, durable inbox or retry worker — a missed
 * delivery self-heals on the learner's next web visit.
 */
@Controller('messenger/wispace')
@UseGuards(InternalApiKeyGuard)
export class WebActivityController {
  constructor(
    private readonly webActivityService: WebActivityService,
    private readonly metrics: BotMetricsService,
  ) {}

  @Post('web-activity')
  @HttpCode(200)
  async record(@Body() body: RecordWebActivityBody): Promise<{ ok: true }> {
    await this.webActivityService.recordActive(body.userId, body.activeAt);
    this.metrics.incWebActivityWebhookReceived();
    return { ok: true };
  }
}
