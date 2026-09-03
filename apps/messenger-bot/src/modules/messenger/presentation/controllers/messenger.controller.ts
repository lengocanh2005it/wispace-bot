import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import { WebhookThrottle } from '@wispace/bot-common/redis';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';
import { MessengerService } from '../../application/services/messenger.service';
import { MessengerProfileService } from '../../infrastructure/meta/messenger-profile.service';
import { MessengerWebhookPayloadDto } from '../dto/messenger-webhook-payload.dto';
import { mapMessengerPayload } from '../mappers/messenger-webhook.mapper';

@Controller()
export class MessengerController {
  constructor(
    private readonly messengerService: MessengerService,
    private readonly messengerProfileService: MessengerProfileService,
  ) {}

  @Get('webhook')
  @UseGuards(ThrottlerGuard)
  @WebhookThrottle()
  verifyWebhook(
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.messengerService.verifyWebhook(token, challenge);
  }

  @Post('webhook')
  @UseGuards(MessengerWebhookSignatureGuard, ThrottlerGuard)
  @WebhookThrottle()
  @HttpCode(200)
  async receiveWebhook(@Body() payload: MessengerWebhookPayloadDto) {
    if (payload.object !== 'page') {
      throw new NotFoundException('Unsupported webhook object');
    }

    const result = await this.messengerService.handleWebhook(
      mapMessengerPayload(payload),
    );
    return {
      ok: true,
      ...result,
    };
  }

  @Post('messenger/profile/setup')
  @UseGuards(InternalApiKeyGuard, ThrottlerGuard)
  @HttpCode(200)
  setupProfile() {
    return this.messengerProfileService.setupProfile();
  }
}
