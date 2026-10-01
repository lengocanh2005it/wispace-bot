import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { WebhookThrottle } from '@wispace/bot-common/redis';
import { withRootSpan } from '@wispace/bot-common/tracing';
import { ZaloWebhookIngestService } from '../../application/zalo-webhook-ingest.service';
import { ZaloWebhookSignatureGuard } from '../guards/zalo-webhook-signature.guard';
import { ZaloWebhookEventDto } from '../dto/zalo-webhook-event.dto';
import { mapZaloEvent } from '../mappers/zalo-webhook.mapper';

/** Thin presentation layer: authenticate, durably ingest, then acknowledge. */
@Controller('zalo/webhook')
@UseGuards(ZaloWebhookSignatureGuard, ThrottlerGuard)
export class ZaloWebhookController {
  constructor(private readonly ingestService: ZaloWebhookIngestService) {}

  @Post()
  @WebhookThrottle()
  async handleWebhook(
    @Body() body: ZaloWebhookEventDto,
  ): Promise<{ received: true }> {
    // HttpInstrumentation already opens a server span for the POST, so this
    // is a child of it and the ingest reads as part of the request (#1459).
    // It does NOT cover the chat turn: dispatch is fire-and-forget and
    // carries no traceparent, so the worker starts a fresh trace.
    return withRootSpan(
      'zalo-bot',
      'zalo.webhook',
      { 'zalo.event_len': JSON.stringify(body).length },
      async () => {
        await this.ingestService.ingestEvent(mapZaloEvent(body));
        return { received: true };
      },
    );
  }
}
