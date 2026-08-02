import { Injectable, Logger } from '@nestjs/common';
import { ZaloTokenService } from '@zalo/modules/zalo-oauth/application/services/zalo-token.service';
import type { ZaloMessageSenderPort } from '@zalo/modules/zalo-webhook/domain/ports/zalo-message-sender.port';
import { ZaloDeliveryLogService } from '../../infrastructure/persistence/zalo-delivery-log.service';

const SEND_TEXT_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const SEND_TIMEOUT_MS = 10_000;
const RETRY_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1_000;

export class ZaloSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string,
    readonly httpStatus = status,
  ) {
    super(message);
    this.name = 'ZaloSendError';
  }

  /**
   * Detects 48h consultation window errors from Zalo API.
   * Zalo returns HTTP 400 with error codes like:
   * - 4001: "Invalid user id" (not a window error)
   * - 4020: "OA has been sent the maximum number of messages" (rate limit)
   * - 4021: "User not interacted with OA in the last 48h" (48h window)
   * - 4022: "Cannot send message to user" (general failure)
   * We detect by checking for 400 status + body containing window-related markers.
   */
  is48hWindowError(): boolean {
    if (this.httpStatus !== 400) return false;
    const body = this.responseBody.toLowerCase();
    return (
      body.includes('4021') ||
      body.includes('not interacted') ||
      body.includes('48h') ||
      body.includes('48 hour') ||
      body.includes('outside') ||
      body.includes('consultation window')
    );
  }

  isRetryable(): boolean {
    return this.httpStatus === 0 || this.httpStatus >= 500;
  }
}

/**
 * MessageSenderPort-equivalent for Zalo — sends a "consultation" text
 * message (works within the 48h window; ZNS for outside that window is
 * future work, see spec §11.4).
 */
@Injectable()
export class ZaloOutboundService implements ZaloMessageSenderPort {
  private readonly logger = new Logger(ZaloOutboundService.name);

  constructor(
    private readonly tokenService: ZaloTokenService,
    private readonly deliveryLogService: ZaloDeliveryLogService,
  ) {}

  async sendText(zaloUserId: string, text: string): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        await this.sendTextOnce(zaloUserId, text);
        await this.deliveryLogService.logDelivery({
          externalUserId: zaloUserId,
          status: 'SENT',
          messageType: 'chat',
        });
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof ZaloSendError && !error.isRetryable()) {
          break;
        }
        if (attempt < RETRY_MAX_ATTEMPTS) {
          const delayMs = RETRY_BASE_DELAY_MS * attempt;
          this.logger.warn(
            `Zalo send attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed for zaloUserId=${zaloUserId}, retrying in ${delayMs}ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    await this.deliveryLogService.logDelivery({
      externalUserId: zaloUserId,
      status: 'FAILED',
      messageType: 'chat',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }

  private async sendTextOnce(zaloUserId: string, text: string): Promise<void> {
    const accessToken = await this.tokenService.getValidAccessToken();

    let response: Response;
    try {
      response = await fetch(SEND_TEXT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: accessToken,
        },
        body: JSON.stringify({
          recipient: { user_id: zaloUserId },
          message: { text },
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Zalo send network error for zaloUserId=${zaloUserId}: ${msg}`,
      );
      throw new ZaloSendError(
        `Zalo Send API network error for ${zaloUserId}: ${msg}`,
        0,
        'Network Error',
        msg,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const applicationError =
      payload && typeof payload === 'object' && 'error' in payload
        ? Number((payload as { error?: unknown }).error)
        : 0;

    if (
      !response.ok ||
      (Number.isFinite(applicationError) && applicationError !== 0)
    ) {
      this.logger.warn(
        `Zalo send message failed HTTP ${response.status} for zaloUserId=${zaloUserId}: ${body}`,
      );
      throw new ZaloSendError(
        `Zalo Send API failed for ${zaloUserId}: HTTP ${response.status} ${response.statusText} - ${body}`,
        applicationError || response.status,
        response.statusText,
        body,
        response.status,
      );
    }
  }
}
