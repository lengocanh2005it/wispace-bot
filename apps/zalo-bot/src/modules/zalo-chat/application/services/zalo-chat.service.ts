import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZaloWebhookHandler } from '../../../zalo-webhook/domain/ports/zalo-webhook-handler.port';
import { ZaloAgentService } from '../agent/zalo-agent.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '../../../zalo-oauth/application/services/zalo-account-link.service';

const FALLBACK_ERROR_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

const UNSUPPORTED_MESSAGE_TYPE_MESSAGE =
  'Hiện mình chỉ hỗ trợ tin nhắn văn bản thôi nhé. Bạn gõ câu hỏi bằng chữ giúp mình nha!';

/**
 * Orchestrates webhook message → account-link lookup → LLM agent →
 * outbound reply. Handles each message immediately, no debounce
 * (spec §4/Global Constraints).
 */
@Injectable()
export class ZaloChatService implements ZaloWebhookHandler {
  private readonly logger = new Logger(ZaloChatService.name);
  private readonly oauthAuthorizeUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: ZaloAgentService,
    private readonly outboundService: ZaloOutboundService,
    private readonly accountLinkService: ZaloAccountLinkService,
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

  async handleIncomingMessage(zaloUserId: string, text: string): Promise<void> {
    try {
      const userId =
        await this.accountLinkService.findUserIdByZaloId(zaloUserId);
      const reply = await this.agentService.reply({
        zaloUserId,
        userId,
        userText: text,
      });
      await this.outboundService.sendText(zaloUserId, reply.text);
    } catch (error) {
      this.logger.error(
        `Chat reply failed for zaloUserId=${zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.outboundService.sendText(zaloUserId, FALLBACK_ERROR_MESSAGE);
    }
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
