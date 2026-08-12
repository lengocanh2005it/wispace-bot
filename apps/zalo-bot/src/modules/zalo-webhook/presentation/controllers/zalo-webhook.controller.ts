import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

type ZaloWebhookRequest = Request & { rawBody?: Buffer };
import {
  isZaloWebhookTimestampFresh,
  verifyZaloWebhookSignature,
} from '../../application/utils/zalo-webhook-signature.utils';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookIngestService } from '../../application/zalo-webhook-ingest.service';

/**
 * Thin presentation layer: authenticate the webhook request, then delegate
 * durable ingestion (persist → claim → dispatch → mark) to the application
 * service. A persistence failure propagates → non-2xx → the platform
 * redelivers instead of acknowledging an event that was never stored.
 */
@Controller('zalo/webhook')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly ingestService: ZaloWebhookIngestService,
  ) {}

  @Post()
  async handleWebhook(
    @Body() body: ZaloWebhookEvent,
    @Req() req: ZaloWebhookRequest,
    @Headers('x-zevent-signature') signatureHeader: string | undefined,
    @Headers('x-zevent-timestamp') timestampHeader: string | undefined,
  ): Promise<{ received: true }> {
    const appId = this.configService.getOrThrow<string>('ZALO_APP_ID');
    const appSecretKey = this.configService.getOrThrow<string>(
      'ZALO_APP_SECRET_KEY',
    );
    const rawBody = (req.rawBody ?? Buffer.from(JSON.stringify(body))).toString(
      'utf8',
    );
    const timestamp = timestampHeader ?? body.timestamp;

    const valid = verifyZaloWebhookSignature({
      appId,
      rawBody,
      timestamp,
      appSecretKey,
      signatureHeader,
    });

    if (!valid) {
      this.logger.warn('Rejected webhook request — signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!isZaloWebhookTimestampFresh(timestamp)) {
      this.logger.warn('Rejected webhook request — stale timestamp');
      throw new UnauthorizedException('Stale webhook timestamp');
    }

    await this.ingestService.processEvent(body);
    return { received: true };
  }
}
