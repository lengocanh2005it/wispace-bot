import {
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import { isStrictProductionRuntime } from '@messenger/shared/config/production-runtime.utils';

@Injectable()
export class ChatRateLimitStartupService implements OnModuleInit {
  private readonly logger = new Logger(ChatRateLimitStartupService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chatRateLimitConfigService: ChatRateLimitConfigService,
  ) {}

  onModuleInit(): void {
    if (!isStrictProductionRuntime(this.configService)) {
      return;
    }

    if (!this.chatRateLimitConfigService.isEnabled()) {
      throw new InternalServerErrorException(
        'CHAT_RATE_LIMIT_ENABLED must be true in production — free-form chat quota is required (H1)',
      );
    }

    this.logger.log('CHAT_RATE_LIMIT_ENABLED is true in production runtime');
  }
}
