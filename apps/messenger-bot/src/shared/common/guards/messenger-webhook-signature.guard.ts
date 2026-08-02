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

    return true;
  }
}
