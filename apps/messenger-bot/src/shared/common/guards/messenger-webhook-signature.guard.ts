import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import {
  getMessengerAppSecret,
  isMessengerWebhookSignatureVerifyEnabled,
} from '../utils/messenger-webhook-signature.config';
import { isTestRuntime } from '@messenger/shared/config/production-runtime.utils';
import {
  META_WEBHOOK_SIGNATURE_HEADER,
  verifyMessengerWebhookSignature,
} from '../utils/messenger-webhook-signature.utils';

const META_WEBHOOK_TIMESTAMP_HEADER = 'x-hub-timestamp';
const MAX_WEBHOOK_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes — match Zalo freshness window

type MessengerWebhookRequest = Request & { rawBody?: Buffer };

@Injectable()
export class MessengerWebhookSignatureGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!isMessengerWebhookSignatureVerifyEnabled(this.configService)) {
      if (isTestRuntime(this.configService)) {
        return true;
      }
      throw new InternalServerErrorException(
        'MESSENGER_APP_SECRET and webhook signature verification are required outside tests',
      );
    }

    const appSecret = getMessengerAppSecret(this.configService);
    if (!appSecret) {
      throw new InternalServerErrorException(
        'MESSENGER_APP_SECRET must be set when MESSENGER_WEBHOOK_SIGNATURE_VERIFY is enabled',
      );
    }

    const request = context
      .switchToHttp()
      .getRequest<MessengerWebhookRequest>();
    const rawBody = request.rawBody;

    if (!rawBody || rawBody.length === 0) {
      throw new ForbiddenException(
        'Missing raw request body for webhook signature verification',
      );
    }

    const signatureHeader = request.header(META_WEBHOOK_SIGNATURE_HEADER);
    if (!verifyMessengerWebhookSignature(rawBody, appSecret, signatureHeader)) {
      throw new ForbiddenException('Invalid Meta webhook signature');
    }

    // Replay protection: reject stale events (#350)
    // Meta sends X-Hub-Timestamp as Unix seconds. Reject if >5 minutes old
    // to prevent replay after durable inbox retention cleanup.
    const timestampHeader = request.header(META_WEBHOOK_TIMESTAMP_HEADER);
    if (!timestampHeader) {
      throw new ForbiddenException('Missing Meta webhook timestamp');
    }
    const timestampMs = Number(timestampHeader) * 1000;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > MAX_WEBHOOK_CLOCK_SKEW_MS
    ) {
      throw new ForbiddenException('Stale Meta webhook timestamp');
    }

    return true;
  }
}
