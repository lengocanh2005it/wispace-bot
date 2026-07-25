import { Injectable, Logger } from '@nestjs/common';
import { ZaloTokenService } from '../../../zalo-oauth/application/services/zalo-token.service';

const SEND_TEXT_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';

/**
 * MessageSenderPort-equivalent for Zalo — sends a "consultation" text
 * message (works within the 48h window; ZNS for outside that window is
 * future work, see spec §11.4).
 */
@Injectable()
export class ZaloOutboundService {
  private readonly logger = new Logger(ZaloOutboundService.name);

  constructor(
    private readonly tokenService: ZaloTokenService,
    private readonly httpFetch: typeof fetch = fetch,
  ) {}

  async sendText(zaloUserId: string, text: string): Promise<void> {
    try {
      const accessToken = await this.tokenService.getValidAccessToken();

      const response = await this.httpFetch(SEND_TEXT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: accessToken,
        },
        body: JSON.stringify({
          recipient: { user_id: zaloUserId },
          message: { text },
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `Zalo send message failed HTTP ${response.status} for zaloUserId=${zaloUserId}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to send Zalo message to zaloUserId=${zaloUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
