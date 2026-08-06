import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZaloWebhookHandler } from '@zalo/modules/zalo-webhook/domain/ports/zalo-webhook-handler.port';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { PlatformChatQueueService } from '@wispace/chat-agent';
import { ZaloRescheduleConfirmationService } from './zalo-reschedule-confirmation.service';
import {
  RESCHEDULE_CONFIRM_KEYWORDS,
  RESCHEDULE_CANCEL_KEYWORDS,
} from '../constants/zalo-reschedule.constants';
import { IntentDetector } from '@wispace/intent-detector';

const FALLBACK_ERROR_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

const UNSUPPORTED_MESSAGE_TYPE_MESSAGE =
  'Hiện mình chỉ hỗ trợ tin nhắn văn bản thôi nhé. Bạn gõ câu hỏi bằng chữ giúp mình nha!';

const GREETING_TEMPLATE =
  'Chào bạn! 👋 Mình là trợ lý WISPACE trên Zalo. Hiện tại một số tính năng chưa khả dụng trên Zalo — bạn có thể dùng Messenger để xem lịch học và tiến độ đầy đủ nhé!';

const SELF_INTRO_TEMPLATE =
  'Mình là WISPACE Bot — trợ lý AI hỗ trợ học IELTS Writing trên Zalo. Hiện tại một số tính năng cá nhân hoá chưa khả dụng trên Zalo. Bạn có thể dùng Messenger để trải nghiệm đầy đủ! 🎓';

@Injectable()
export class ZaloChatService implements ZaloWebhookHandler {
  private readonly logger = new Logger(ZaloChatService.name);
  private readonly oauthAuthorizeUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly outboundService: ZaloOutboundService,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly chatQueueService: PlatformChatQueueService,
    private readonly rescheduleConfirmationService: ZaloRescheduleConfirmationService,
  ) {
    const appId = this.configService.get<string>('ZALO_APP_ID');
    const redirectUri = this.configService.get<string>(
      'ZALO_OAUTH_REDIRECT_URI',
    );
    this.oauthAuthorizeUrl =
      appId && redirectUri
        ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
        : '';
  }

  async handleIncomingMessage(
    zaloUserId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void> {
    // Intent detection: greeting/self-intro → reply directly, skip LLM
    const intentDetector = new IntentDetector();
    const intent = intentDetector.detect(text.trim());
    if (intent.intent === 'greeting') {
      await this.outboundService.sendText(zaloUserId, GREETING_TEMPLATE);
      return;
    }
    if (intent.intent === 'self_intro') {
      await this.outboundService.sendText(zaloUserId, SELF_INTRO_TEMPLATE);
      return;
    }

    try {
      const userId =
        await this.accountLinkService.findUserIdByZaloId(zaloUserId);

      if (
        this.rescheduleConfirmationService.hasPending(zaloUserId) &&
        this.isConfirmKeyword(text.trim())
      ) {
        const result = await this.rescheduleConfirmationService.confirm(
          zaloUserId,
          userId,
        );
        if (result.confirmed) {
          await this.outboundService.sendText(
            zaloUserId,
            `Đã dời buổi học sang ${result.scheduledTimeLabel} nhé.`,
          );
          return;
        }
        await this.outboundService.sendText(zaloUserId, result.message);
        return;
      }

      if (
        this.rescheduleConfirmationService.hasPending(zaloUserId) &&
        this.isCancelKeyword(text.trim())
      ) {
        const message = this.rescheduleConfirmationService.cancel(zaloUserId);
        await this.outboundService.sendText(zaloUserId, message);
        return;
      }

      const key = idempotencyKey ?? `zalo:${zaloUserId}:${Date.now()}`;
      this.chatQueueService.enqueue(zaloUserId, text, { userId }, key);
    } catch (error) {
      this.logger.error(
        `Chat enqueue failed for zaloUserId=${zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        await this.outboundService.sendText(zaloUserId, FALLBACK_ERROR_MESSAGE);
      } catch {
        // ignore
      }
    }
  }

  private isConfirmKeyword(text: string): boolean {
    return RESCHEDULE_CONFIRM_KEYWORDS.includes(text.toLowerCase());
  }

  private isCancelKeyword(text: string): boolean {
    return RESCHEDULE_CANCEL_KEYWORDS.includes(text.toLowerCase());
  }

  async handleFollow(zaloUserId: string): Promise<void> {
    const linkPart = this.oauthAuthorizeUrl
      ? `\n\nLiên kết tài khoản tại đây: ${this.oauthAuthorizeUrl}`
      : '';
    const message = `Chào bạn! Mình là trợ lý học tập WISPACE. Bạn có thể hỏi mình bất cứ điều gì. Để xem lịch học, tiến độ và các tính năng cá nhân hoá, hãy liên kết tài khoản WISPACE${linkPart}`;
    await this.outboundService.sendText(zaloUserId, message);
  }

  async handleUnsupportedMessage(zaloUserId: string): Promise<void> {
    await this.outboundService.sendText(
      zaloUserId,
      UNSUPPORTED_MESSAGE_TYPE_MESSAGE,
    );
  }
}
