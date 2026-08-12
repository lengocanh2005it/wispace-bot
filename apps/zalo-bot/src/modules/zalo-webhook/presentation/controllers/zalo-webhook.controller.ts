import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { ConfigService } from '@nestjs/config';
import {
  PlatformWebhookInboundEventService,
  readInboundRetryConfig,
} from '@wispace/database';
import type { Request } from 'express';

type ZaloWebhookRequest = Request & { rawBody?: Buffer };
import {
  isZaloWebhookTimestampFresh,
  verifyZaloWebhookSignature,
} from '../../application/utils/zalo-webhook-signature.utils';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookDispatchService } from '../../application/zalo-webhook-dispatch.service';

/** Stable per-delivery event id for the durable inbox. */
function buildEventId(event: ZaloWebhookEvent): string {
  if (event.event_name === 'user_send_text' && event.message?.msg_id) {
    return event.message.msg_id;
  }
  const userId = event.sender?.id ?? event.follower?.id ?? 'unknown';
  return `${event.event_name}:${userId}:${event.timestamp ?? Date.now()}`;
}

@Controller('zalo/webhook')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dispatcher: ZaloWebhookDispatchService,
    private readonly inboundEvents: PlatformWebhookInboundEventService,
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

    // Durable ingestion: persist before acknowledging. A duplicate delivery
    // is skipped; a persistence failure propagates (non-2xx) so the event is
    // not lost. Processing failures are recorded for the retry cron.
    const eventId = buildEventId(body);
    const { inserted, id } = await this.inboundEvents.ingest({
      eventId,
      externalUserId: body.sender?.id ?? body.follower?.id ?? null,
      eventType: body.event_name,
      rawPayload: body,
    });

    if (!inserted) {
      this.logger.debug(`Skipping duplicate webhook event id=${eventId}`);
      return { received: true };
    }

    try {
      await this.dispatcher.dispatch(body);
      if (id !== undefined) {
        await this.inboundEvents.markCompleted(id);
      }
    } catch (error) {
      const errorMessageValue = errorMessage(error);
      this.logger.warn(
        `Webhook event failed — scheduled for retry: ${errorMessageValue}`,
      );
      if (id !== undefined) {
        await this.inboundEvents
          .markFailed(
            id,
            errorMessageValue,
            readInboundRetryConfig((key) =>
              this.configService.get<string>(key),
            ),
          )
          .catch((saveErr: unknown) => {
            this.logger.error(
              `Failed to record inbound event failure: ${errorMessage(saveErr)}`,
            );
          });
      }
    }
    return { received: true };
  }
}
