import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isTestRuntime,
  readWispaceVerifyTokenUrl,
} from '@messenger/shared/config/production-runtime.utils';

@Injectable()
export class MessengerLinkStartupService implements OnModuleInit {
  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    if (isTestRuntime(this.configService)) {
      return;
    }

    const mode = this.configService.get<string>('MESSENGER_LINK_MODE')?.trim();
    if (mode && mode.toLowerCase() !== 'token') {
      throw new InternalServerErrorException(
        `MESSENGER_LINK_MODE must be "token" (got "${mode}") — legacy ref=userId linking was removed`,
      );
    }

    const verifyUrl = readWispaceVerifyTokenUrl(this.configService);
    if (!verifyUrl) {
      throw new InternalServerErrorException(
        'WISPACE_API_VERIFY_TOKEN_URL must be set — Messenger account linking requires WISPACE token verify',
      );
    }

    const internalKey = this.configService
      .get<string>('WISPACE_INTERNAL_KEY')
      ?.trim();
    if (!internalKey) {
      throw new InternalServerErrorException(
        'WISPACE_INTERNAL_KEY must be set for messenger link token verify',
      );
    }
  }
}
