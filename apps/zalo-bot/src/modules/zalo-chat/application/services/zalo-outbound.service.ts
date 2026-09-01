import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { isAbortError, readResponseText } from '@wispace/bot-common/utils';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ZaloTokenService } from '@zalo/modules/zalo-oauth/application/services/zalo-token.service';
import {
  DeliveryLogService,
  PlatformDeadLetterService,
} from '@wispace/database';
import { withRetry } from '@wispace/wispace-client';
import { OutboundRateLimiter } from '@wispace/bot-common/redis';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';

const SEND_TEXT_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const SEND_TIMEOUT_MS = 10_000;
const SEND_FAILURE_REASON_AMBIGUOUS = 'dm_send_ambiguous';

export class ZaloSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string,
    readonly httpStatus = status,
    originalError?: unknown,
  ) {
    super(message);
    this.name = 'ZaloSendError';
    this.retryable =
      !isAbortError(originalError) &&
      (this.httpStatus === 0 || this.httpStatus >= 500);
  }

  private readonly retryable: boolean;

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
    return this.retryable;
  }

  isAmbiguousDelivery(): boolean {
    return this.httpStatus === 0;
  }
}

class ZaloRateLimitError extends Error {
  constructor() {
    super('Outbound message rate limit exceeded');
    this.name = 'ZaloRateLimitError';
  }
}

export function isZaloRetryableError(error: unknown): boolean {
  return error instanceof ZaloSendError && error.isRetryable();
}

export function isZaloAmbiguousDeliveryError(error: unknown): boolean {
  return error instanceof ZaloSendError && error.isAmbiguousDelivery();
}

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
    private readonly deliveryLogService: DeliveryLogService,
    @Optional()
    @Inject(PlatformDeadLetterService)
    private readonly deadLetter?: PlatformDeadLetterService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
    @Optional()
    @Inject(OutboundRateLimiter)
    private readonly outboundRateLimiter?: OutboundRateLimiter,
  ) {}

  isAmbiguousDeliveryError(error: unknown): boolean {
    return isZaloAmbiguousDeliveryError(error);
  }

  async sendText(
    zaloUserId: string,
    text: string,
    options?: {
      skipDeadLetter?: boolean;
      deliveryKey?: string;
      clarification?: boolean;
      deadLetterOn?: 'all' | 'ambiguous' | 'none';
      retryOn?: 'all' | 'none';
      userId?: number;
      units?: number;
      skipRateLimit?: boolean;
    },
  ): Promise<OutboundDeliveryOutcome> {
    let ambiguousDeliveryRecorded = false;
    let providerAttempt = 0;
    try {
      await withRetry(
        () => {
          const units = providerAttempt === 0 ? (options?.units ?? 1) : 1;
          providerAttempt += 1;
          return this.sendTextOnce(zaloUserId, text, {
            userId: options?.userId,
            units,
            skipRateLimit: options?.skipRateLimit,
          });
        },
        {
          maxRetries: 1,
          baseDelayMs: 1_000,
          shouldRetry: (error) => {
            if (options?.retryOn === 'none') return false;
            if (
              options?.clarification === true &&
              error instanceof ZaloSendError &&
              error.isAmbiguousDelivery()
            ) {
              return false;
            }
            return isZaloRetryableError(error);
          },
          onRetry: (attempt, maxRetries, error) => {
            if (error instanceof ZaloSendError && error.isAmbiguousDelivery()) {
              this.metrics?.incDmDeliveryFailure(SEND_FAILURE_REASON_AMBIGUOUS);
              ambiguousDeliveryRecorded = true;
            }
            this.logger.warn(
              `Zalo send attempt ${attempt}/${maxRetries + 1} failed for zaloUserId=${maskExternalId(zaloUserId)}, retrying`,
            );
          },
        },
      );
      await this.deliveryLogService.logDelivery({
        externalUserId: zaloUserId,
        status: 'SENT',
        messageType: 'chat',
      });
      return 'sent';
    } catch (error) {
      if (error instanceof ZaloRateLimitError) {
        if (ambiguousDeliveryRecorded) {
          throw new ZaloSendError(
            'Zalo delivery outcome is ambiguous after an outbound rate-limit denial',
            0,
            'Unknown',
            '',
            0,
          );
        }
        return 'rate_limited';
      }
      const errorMsg = maskExternalIdInText(errorMessage(error), zaloUserId);
      if (
        !ambiguousDeliveryRecorded &&
        error instanceof ZaloSendError &&
        error.isAmbiguousDelivery()
      ) {
        this.metrics?.incDmDeliveryFailure(SEND_FAILURE_REASON_AMBIGUOUS);
      }
      await this.deliveryLogService.logDelivery({
        externalUserId: zaloUserId,
        status: 'FAILED',
        messageType: 'chat',
        error: errorMsg,
      });
      const ambiguous =
        error instanceof ZaloSendError && error.isAmbiguousDelivery();
      const shouldPersistDeadLetter =
        options?.deadLetterOn === 'ambiguous'
          ? ambiguous
          : options?.deadLetterOn === 'none'
            ? false
            : options?.skipDeadLetter !== true &&
              (options?.clarification !== true || !ambiguous);
      if (shouldPersistDeadLetter) {
        const persisted = await this.deadLetter?.save({
          externalUserId: zaloUserId,
          rawPayload: { zaloUserId, text },
          errorMessage: errorMsg,
          direction: 'outbound',
          ...(options?.deliveryKey ? { deliveryKey: options.deliveryKey } : {}),
        });
        if (persisted === false) {
          this.logger.error(
            `No durable recovery record for failed send to zaloUserId=${maskExternalId(
              zaloUserId,
            )} — dead-letter persistence failed`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Crash-safe dead-letter replay send (#291): Zalo has no idempotency field
   * in the current send payload, so the delivery key is a tracking key only.
   * Ambiguous outcomes are terminal (provider may have accepted) — the cron
   * never auto-resends them. Never dead-letters again (the cron owns retry).
   */
  async sendTextForRetry(
    zaloUserId: string,
    text: string,
    _deliveryKey: string,
  ): Promise<OutboundDeliveryOutcome> {
    let ambiguousDeliveryRecorded = false;
    try {
      await withRetry(() => this.sendTextOnce(zaloUserId, text), {
        maxRetries: 1,
        baseDelayMs: 1_000,
        shouldRetry: isZaloRetryableError,
        onRetry: (attempt, maxRetries, error) => {
          if (error instanceof ZaloSendError && error.isAmbiguousDelivery()) {
            this.metrics?.incDmDeliveryFailure(SEND_FAILURE_REASON_AMBIGUOUS);
            ambiguousDeliveryRecorded = true;
          }
          this.logger.warn(
            `Zalo send attempt ${attempt}/${maxRetries + 1} failed for zaloUserId=${maskExternalId(zaloUserId)}, retrying`,
          );
        },
      });
      await this.deliveryLogService.logDelivery({
        externalUserId: zaloUserId,
        status: 'SENT',
        messageType: 'chat',
      });
      return 'sent';
    } catch (error) {
      if (error instanceof ZaloRateLimitError) {
        return ambiguousDeliveryRecorded ? 'ambiguous' : 'rate_limited';
      }
      const errorMsg = maskExternalIdInText(errorMessage(error), zaloUserId);
      await this.deliveryLogService.logDelivery({
        externalUserId: zaloUserId,
        status: 'FAILED',
        messageType: 'chat',
        error: errorMsg,
      });
      if (error instanceof ZaloSendError && error.isAmbiguousDelivery()) {
        this.metrics?.incDmDeliveryFailure(SEND_FAILURE_REASON_AMBIGUOUS);
        return 'ambiguous';
      }
      return 'not_sent';
    }
  }

  private async sendTextOnce(
    zaloUserId: string,
    text: string,
    options?: { userId?: number; units?: number; skipRateLimit?: boolean },
  ): Promise<void> {
    if (
      options?.skipRateLimit !== true &&
      !(await this.admitOutbound(
        zaloUserId,
        options?.userId,
        options?.units ?? 1,
      ))
    ) {
      throw new ZaloRateLimitError();
    }
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
      const msg = maskExternalIdInText(errorMessage(error), zaloUserId);
      this.logger.warn(
        `Zalo send network error for zaloUserId=${maskExternalId(
          zaloUserId,
        )}: ${msg}`,
      );
      throw new ZaloSendError(
        `Zalo Send API network error for ${maskExternalId(zaloUserId)}: ${msg}`,
        0,
        'Network Error',
        msg,
        0,
        error,
      );
    }

    const body = await readResponseText(response);
    let payload: unknown;
    try {
      payload = body ? (JSON.parse(body) as unknown) : undefined;
    } catch {
      payload = undefined;
    }
    const safeBody = maskExternalIdInText(body, zaloUserId);
    const applicationError =
      payload && typeof payload === 'object' && 'error' in payload
        ? Number((payload as { error?: unknown }).error)
        : 0;

    if (
      !response.ok ||
      (Number.isFinite(applicationError) && applicationError !== 0)
    ) {
      this.logger.warn(
        `Zalo send message failed HTTP ${response.status} for zaloUserId=${maskExternalId(zaloUserId)}: ${safeBody}`,
      );
      throw new ZaloSendError(
        `Zalo Send API failed for ${maskExternalId(
          zaloUserId,
        )}: HTTP ${response.status} ${response.statusText} - ${safeBody}`,
        applicationError || response.status,
        response.statusText,
        safeBody,
        response.status,
      );
    }
  }

  private async admitOutbound(
    externalUserId: string,
    userId: number | undefined,
    units: number,
  ): Promise<boolean> {
    if (!this.outboundRateLimiter) return true;
    const result = await this.outboundRateLimiter.admit({
      platform: 'zalo',
      externalUserId,
      userId,
      units,
    });
    this.metrics?.incOutboundRateLimitDecision('zalo', result.outcome);
    return result.allowed;
  }
}
