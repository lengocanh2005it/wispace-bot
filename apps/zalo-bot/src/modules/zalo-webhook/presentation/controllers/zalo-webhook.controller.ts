import {
  Body,
  Controller,
  Headers,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

type ZaloWebhookRequest = Request & { rawBody?: Buffer };
import { verifyZaloWebhookSignature } from '../../application/utils/zalo-webhook-signature.utils';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import {
  ZALO_WEBHOOK_HANDLER,
  type ZaloWebhookHandler,
} from '../../domain/ports/zalo-webhook-handler.port';
import { ZaloWebhookDedupeService } from '../../application/zalo-webhook-dedupe.service';
import { ZaloDeadLetterService } from '@zalo/modules/zalo-chat/application/services/zalo-dead-letter.service';

@Controller('zalo/webhook')
export class ZaloWebhookController {
  private readonly logger = new Logger(ZaloWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(ZALO_WEBHOOK_HANDLER)
    private readonly handler: ZaloWebhookHandler,
    private readonly dedupeService: ZaloWebhookDedupeService,
    private readonly deadLetterService: ZaloDeadLetterService,
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

    try {
      await this.dispatch(body);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Webhook event failed — saving to dead-letter: ${errorMessage}`,
      );
      await this.deadLetterService
        .save({
          externalUserId: body.sender?.id ?? body.follower?.id ?? 'unknown',
          rawPayload: body,
          errorMessage,
        })
        .catch((saveErr: unknown) => {
          this.logger.error(
            `Failed to save dead-letter entry: ${
              saveErr instanceof Error ? saveErr.message : String(saveErr)
            }`,
          );
        });
    }
    return { received: true };
  }

  private async dispatch(event: ZaloWebhookEvent): Promise<void> {
    switch (event.event_name) {
      case 'user_send_text': {
        const senderId = event.sender?.id;
        const text = event.message?.text;
        const msgId = event.message?.msg_id;
        if (senderId && text) {
          if (msgId && (await this.dedupeService.isDuplicate(msgId))) {
            this.logger.debug(`Skipping duplicate webhook msg_id=${msgId}`);
            return;
          }
          await this.handler.handleIncomingMessage(senderId, text, msgId);
        }
        return;
      }
      case 'follow': {
        const followerId = event.follower?.id;
        if (followerId) {
          await this.handler.handleFollow(followerId);
        }
        return;
      }
      case 'unfollow':
        this.logger.log(`User unfollowed: ${event.follower?.id ?? 'unknown'}`);
        return;
      default:
        if (event.event_name.startsWith('oa_send_')) {
          // Echo of our own outbound message — ignore to avoid loops.
          return;
        }
        if (event.event_name.startsWith('user_send_')) {
          const senderId = event.sender?.id;
          if (senderId) {
            await this.handler.handleUnsupportedMessage(senderId);
          }
          return;
        }
        this.logger.debug(`Unhandled event_name=${event.event_name}`);
        return;
    }
  }
}
