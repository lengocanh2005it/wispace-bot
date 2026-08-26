import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { WebhookThrottle } from '@wispace/bot-common/redis';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookIngestService } from '../../application/zalo-webhook-ingest.service';
import { ZaloWebhookSignatureGuard } from '../guards/zalo-webhook-signature.guard';
import { ZaloWebhookEventDto } from '../dto/zalo-webhook-event.dto';

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
    await this.ingestService.ingestEvent(body as unknown as ZaloWebhookEvent);
    return { received: true };
  }
}
