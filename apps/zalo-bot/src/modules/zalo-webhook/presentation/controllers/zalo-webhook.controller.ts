import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { WebhookThrottle } from '@wispace/bot-common';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookIngestService } from '../../application/zalo-webhook-ingest.service';
import { ZaloWebhookSignatureGuard } from '../guards/zalo-webhook-signature.guard';

/** Thin presentation layer: authenticate, durably ingest, then acknowledge. */
@Controller('zalo/webhook')
@UseGuards(ZaloWebhookSignatureGuard, ThrottlerGuard)
export class ZaloWebhookController {
  constructor(private readonly ingestService: ZaloWebhookIngestService) {}

  @Post()
  @WebhookThrottle()
  async handleWebhook(
    @Body() body: ZaloWebhookEvent,
  ): Promise<{ received: true }> {
    await this.ingestService.ingestEvent(body);
    return { received: true };
  }
}
