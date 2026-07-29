import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isStrictProductionRuntime,
  isTestRuntime,
} from '@messenger/shared/config/production-runtime.utils';
import { isMessengerWebhookSignatureVerifyEnabled } from '@messenger/shared/common/utils/messenger-webhook-signature.config';

@Injectable()
export class MessengerWebhookStartupService implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    if (isTestRuntime(this.configService)) {
      return;
    }

    if (!isStrictProductionRuntime(this.configService)) {
      return;
    }

    const appSecret = this.configService
      .get<string>('MESSENGER_APP_SECRET')
      ?.trim();
    if (!appSecret) {
      throw new InternalServerErrorException(
        'MESSENGER_APP_SECRET must be set in production — POST /webhook signature verification is required',
      );
    }

    const explicitVerify = this.configService
      .get<string>('MESSENGER_WEBHOOK_SIGNATURE_VERIFY')
      ?.trim()
      .toLowerCase();
    if (explicitVerify === 'false') {
      throw new InternalServerErrorException(
        'MESSENGER_WEBHOOK_SIGNATURE_VERIFY must not be false in production',
      );
    }

    if (!isMessengerWebhookSignatureVerifyEnabled(this.configService)) {
      throw new InternalServerErrorException(
        'Messenger webhook signature verification must be enabled in production (set MESSENGER_APP_SECRET)',
      );
    }
  }
}
