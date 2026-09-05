import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { readResponseText } from '@wispace/bot-common/utils';
import { ConfigService } from '@nestjs/config';
import CircuitBreaker from 'opossum';
import { isMessenger24hWindowError } from '../messages/chat-delivery.messages';
import {
  buildProactive24hLogErrorMessage,
  buildProactiveFailureMessageType,
} from '../utils/proactive-send.utils';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '../../domain/repositories/messenger-message-log.repository.port';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import { readMessengerBubbleLimits } from '../utils/messenger-bubble-config.utils';
import { splitMessengerBubbles } from '@messenger/shared/utils/messenger-text.utils';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';
import { keepAliveFetch } from '@messenger/shared/http/http-agent';
import { PlatformDeadLetterService } from '@wispace/database';
import { BotMetricsService } from '@wispace/bot-metrics';
import { OutboundRateLimiter } from '@wispace/bot-common/redis';
import type { OutboundDeliveryOutcome } from '@wispace/contracts';
import { MessengerPlatformConnectivityService } from '../../infrastructure/meta/messenger-platform-connectivity.service';

export class MessengerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'MessengerApiError';
  }

  isTokenExpired(): boolean {
    return (
      this.status === 400 &&
      (this.responseBody.includes('"code":190') ||
        this.responseBody.includes('"code": 190') ||
        this.responseBody.includes('OAuthException'))
    );
  }
}

export function isMessengerAmbiguousDeliveryError(error: unknown): boolean {
  return error instanceof MessengerApiError && error.status === 408;
}

/** H4: at least one bubble was delivered before a later Send API failure. */
export class MessengerPartialSendError extends MessengerApiError {
  constructor(
    readonly bubblesSent: number,
    cause: MessengerApiError,
  ) {
    super(cause.message, cause.status, cause.statusText, cause.responseBody);
    this.name = 'MessengerPartialSendError';
  }
}

export type MessengerSenderAction = 'mark_seen' | 'typing_on' | 'typing_off';

@Injectable()
export class MessengerOutboundService {
  private readonly logger = new Logger(MessengerOutboundService.name);
  private readonly sendBreaker: CircuitBreaker;
  /**
   * Single timeout budget shared by the circuit breaker and the Send API
   * fetch — the breaker can never fire while the fetch keeps running, so a
   * caller failure is never followed by an untracked late delivery.
   */
  private readonly sendApiTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly repository: MessengerMessageLogRepositoryPort,
    @Optional()
    @Inject(PlatformDeadLetterService)
    private readonly deadLetter?: PlatformDeadLetterService,
    @Optional()
    @Inject(OutboundRateLimiter)
    private readonly outboundRateLimiter?: OutboundRateLimiter,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
    @Optional()
    @Inject(MessengerPlatformConnectivityService)
    private readonly platformConnectivity?: MessengerPlatformConnectivityService,
  ) {
    const raw = this.configService.get<string>('MESSENGER_SEND_API_TIMEOUT_MS');
    const parsed = raw ? Number(raw) : NaN;
    this.sendApiTimeoutMs =
      Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10_000;

    this.sendBreaker = new CircuitBreaker(
      async (psid: string, payload: Record<string, unknown>) => {
        await this.doCallSendApi(psid, payload);
      },
      {
        timeout: this.sendApiTimeoutMs,
        errorThresholdPercentage: 50,
        resetTimeout: 60_000,
        volumeThreshold: 5,
      },
    );

    this.sendBreaker.on('open', () => {
      this.logger.warn('Meta Send API circuit breaker OPEN — failing fast');
    });
    this.sendBreaker.on('halfOpen', () => {
      this.logger.log('Meta Send API circuit breaker half-open — testing');
    });
    this.sendBreaker.on('close', () => {
      this.logger.log('Meta Send API circuit breaker closed — recovered');
    });
  }

  async sendSenderAction(
    psid: string,
    senderAction: MessengerSenderAction,
  ): Promise<void> {
    await this.callSendApiByPsid(psid, {
      sender_action: senderAction,
    });
  }

  /** Best-effort UX signal — must not block chat or proactive replies. */
  async sendSenderActionOptional(
    psid: string,
    senderAction: MessengerSenderAction,
  ): Promise<void> {
    try {
      await this.sendSenderAction(psid, senderAction);
    } catch (error) {
      this.logger.debug(
        `Sender action ${senderAction} skipped psid=${maskExternalId(
          psid,
        )}: ${maskExternalIdInText(errorMessage(error), psid)}`,
      );
    }
  }

  async sendTextBubblesViaPsid(params: {
    psid: string;
    text: string;
    messageType: string;
    userId?: number;
    maxBubbles?: number;
    maxCharsPerBubble?: number;
    /** Stable clarification delivery identity (provider currently ignores it). */
    deliveryKey?: string;
    clarification?: boolean;
    skipDeadLetter?: boolean;
  }): Promise<number | 'rate_limited'> {
    const defaults = readMessengerBubbleLimits(this.configService);
    const bubbles = splitMessengerBubbles(
      params.text,
      params.maxBubbles ?? defaults.maxBubbles,
      params.maxCharsPerBubble ?? defaults.maxCharsPerBubble,
    );

    if (!bubbles.length) {
      return 0;
    }

    if (
      (await this.admitOutbound(params.psid, params.userId, bubbles.length)) ===
      'rate_limited'
    ) {
      return 'rate_limited';
    }

    let sentCount = 0;

    for (const [index, bubble] of bubbles.entries()) {
      try {
        await this.sendTextViaPsid({
          psid: params.psid,
          userId: params.userId,
          text: bubble,
          messageType: params.clarification
            ? 'CLARIFICATION'
            : bubbles.length > 1
              ? `${params.messageType}_PART_${index + 1}_OF_${bubbles.length}`
              : params.messageType,
          skipRateLimit: true,
        });
        sentCount += 1;
      } catch (error) {
        const apiError = this.toMessengerApiError(params.psid, error);
        if (sentCount > 0) {
          throw new MessengerPartialSendError(sentCount, apiError);
        }

        if (
          params.clarification &&
          params.skipDeadLetter !== true &&
          !isMessengerAmbiguousDeliveryError(apiError)
        ) {
          const persisted = await this.deadLetter?.save({
            externalUserId: params.psid,
            rawPayload: { psid: params.psid, text: params.text },
            errorMessage: apiError.message,
            direction: 'outbound',
            ...(params.deliveryKey ? { deliveryKey: params.deliveryKey } : {}),
          });
          if (persisted === false) {
            this.logger.error(
              `No durable recovery record for failed clarification to psid=${maskExternalId(
                params.psid,
              )} — dead-letter persistence failed`,
            );
          }
        }

        throw apiError;
      }
    }

    return sentCount;
  }

  async sendRichFollowUps(params: {
    psid: string;
    userId?: number;
    followUps: MessengerRichFollowUp[];
  }): Promise<OutboundDeliveryOutcome> {
    const followUps = params.followUps.filter((followUp) =>
      followUp.kind === 'generic'
        ? followUp.elements.length > 0
        : followUp.buttons.length > 0,
    );
    if (!followUps.length) {
      return 'sent';
    }

    if (
      (await this.admitOutbound(
        params.psid,
        params.userId,
        followUps.length,
      )) === 'rate_limited'
    ) {
      return 'rate_limited';
    }

    for (const followUp of followUps) {
      if (followUp.kind === 'generic') {
        const outcome = await this.sendGenericTemplate({
          psid: params.psid,
          userId: params.userId,
          messageType: followUp.messageType,
          elements: followUp.elements,
          skipRateLimit: true,
        });
        if (outcome === 'rate_limited') return outcome;
        continue;
      }

      const outcome = await this.sendButtonTemplate({
        psid: params.psid,
        userId: params.userId,
        messageType: followUp.messageType,
        text: followUp.text,
        buttons: followUp.buttons,
        skipRateLimit: true,
      });
      if (outcome === 'rate_limited') return outcome;
    }
    return 'sent';
  }

  async sendGenericTemplate(params: {
    psid: string;
    userId?: number;
    messageType: string;
    elements: Array<{
      title: string;
      subtitle?: string;
      buttons?: Array<{
        type: 'postback';
        title: string;
        payload: string;
      }>;
    }>;
    skipRateLimit?: boolean;
  }): Promise<OutboundDeliveryOutcome> {
    if (!params.elements.length) {
      return 'sent';
    }

    if (
      params.skipRateLimit !== true &&
      (await this.admitOutbound(params.psid, params.userId, 1)) ===
        'rate_limited'
    ) {
      return 'rate_limited';
    }

    const payload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: params.elements,
        },
      },
    };

    try {
      await this.callSendApiByPsid(params.psid, {
        message: payload,
      });
      await this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        status: 'SENT',
      });
      return 'sent';
    } catch (error) {
      const errorText = maskExternalIdInText(errorMessage(error), params.psid);
      await this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        status: 'FAILED',
        errorMessage: errorText,
      });
      throw error;
    }
  }

  async sendButtonTemplate(params: {
    psid: string;
    userId?: number;
    messageType: string;
    text: string;
    buttons: Array<{
      type: 'postback';
      title: string;
      payload: string;
    }>;
    skipRateLimit?: boolean;
  }): Promise<OutboundDeliveryOutcome> {
    if (!params.buttons.length) {
      return 'sent';
    }

    if (
      params.skipRateLimit !== true &&
      (await this.admitOutbound(params.psid, params.userId, 1)) ===
        'rate_limited'
    ) {
      return 'rate_limited';
    }

    const payload = {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: params.text,
          buttons: params.buttons,
        },
      },
    };

    try {
      await this.callSendApiByPsid(params.psid, {
        message: payload,
      });
      void this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        status: 'SENT',
      });
      return 'sent';
    } catch (error) {
      const errorText = maskExternalIdInText(errorMessage(error), params.psid);
      void this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        status: 'FAILED',
        errorMessage: errorText,
      });
      throw error;
    }
  }

  async sendTextViaPsid(params: {
    psid: string;
    text: string;
    messageType: string;
    userId?: number;
    skipRateLimit?: boolean;
  }): Promise<OutboundDeliveryOutcome> {
    if (
      params.skipRateLimit !== true &&
      (await this.admitOutbound(params.psid, params.userId, 1)) ===
        'rate_limited'
    ) {
      return 'rate_limited';
    }

    try {
      await this.callSendApiByPsid(params.psid, {
        message: { text: params.text },
      });
      void this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        status: 'SENT',
      });
      return 'sent';
    } catch (error) {
      await this.logSendFailure(params, error);
      throw error;
    }
  }

  /**
   * Outbound surface used by the shared study-reminder MessageSenderPort
   * (@wispace/study-reminder-shared wrapMessageSender). Keeps the messenger
   * message log + 24h classification via sendTextViaPsid.
   */
  async sendText(
    externalUserId: string,
    text: string,
    input?: {
      messageType?: string;
      userId?: number;
      deliveryKey?: string;
      clarification?: boolean;
      skipRateLimit?: boolean;
    },
  ): Promise<OutboundDeliveryOutcome> {
    return this.sendTextViaPsid({
      psid: externalUserId,
      text,
      messageType: input?.messageType ?? 'STUDY_REMINDER',
      userId: input?.userId,
      skipRateLimit: input?.skipRateLimit,
    });
  }

  isAmbiguousDeliveryError(error: unknown): boolean {
    return isMessengerAmbiguousDeliveryError(error);
  }

  async sendTextForRetry(
    psid: string,
    text: string,
    deliveryKey: string,
  ): Promise<OutboundDeliveryOutcome> {
    try {
      const result = await this.sendTextBubblesViaPsid({
        psid,
        text,
        messageType: 'FREE_FORM_CHAT_OUT',
        clarification: true,
        deliveryKey,
        skipDeadLetter: true,
      });
      if (result === 'rate_limited') return result;
      return 'sent';
    } catch (error) {
      return isMessengerAmbiguousDeliveryError(error)
        ? 'ambiguous'
        : 'not_sent';
    }
  }

  private async admitOutbound(
    externalUserId: string,
    userId: number | undefined,
    units: number,
  ): Promise<'allowed' | 'rate_limited'> {
    if (!this.outboundRateLimiter) return 'allowed';
    const result = await this.outboundRateLimiter.admit({
      platform: 'messenger',
      externalUserId,
      userId,
      units,
    });
    this.metrics?.incOutboundRateLimitDecision('messenger', result.outcome);
    return result.allowed ? 'allowed' : 'rate_limited';
  }

  private async logSendFailure(
    params: {
      psid: string;
      text: string;
      messageType: string;
      userId?: number;
    },
    error: unknown,
  ): Promise<void> {
    const apiError = this.toMessengerApiError(params.psid, error);
    const is24h = isMessenger24hWindowError(apiError);
    const isExpired = apiError.isTokenExpired();

    if (isExpired || apiError.status === 401 || apiError.status === 403) {
      this.platformConnectivity?.markTokenRejected();
    }
    if (isExpired) {
      this.logger.error(
        'PAGE_ACCESS_TOKEN_EXPIRED: Meta returned OAuthException(code=190) — rotate the token immediately',
      );
    }

    const errorMessage = is24h
      ? buildProactive24hLogErrorMessage()
      : apiError.message;

    await this.repository.logMessage({
      userId: params.userId,
      psid: params.psid,
      messageType: isExpired
        ? 'META_TOKEN_EXPIRED'
        : is24h
          ? buildProactiveFailureMessageType(params.messageType)
          : params.messageType,
      status: 'FAILED',
      errorMessage,
    });
  }

  private toMessengerApiError(psid: string, error: unknown): MessengerApiError {
    if (error instanceof MessengerApiError) {
      return new MessengerApiError(
        maskExternalIdInText(error.message, psid),
        error.status,
        error.statusText,
        maskExternalIdInText(error.responseBody, psid),
      );
    }

    const message = maskExternalIdInText(errorMessage(error), psid);
    return new MessengerApiError(
      `Messenger Send API failed for PSID ${maskExternalId(psid)}: ${message}`,
      0,
      'Error',
      message,
    );
  }

  private async callSendApiByPsid(
    psid: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.sendBreaker.fire(psid, payload);
      this.platformConnectivity?.markOutboundSuccess();
    } catch (error) {
      if (error instanceof Error && CircuitBreaker.isOurError(error)) {
        throw new MessengerApiError(
          `Meta Send API circuit breaker is OPEN for PSID ${maskExternalId(
            psid,
          )}`,
          503,
          'Service Unavailable',
          '',
        );
      }
      const apiError = this.toMessengerApiError(psid, error);
      if (
        apiError.isTokenExpired() ||
        apiError.status === 401 ||
        apiError.status === 403
      ) {
        this.platformConnectivity?.markTokenRejected();
      }
      throw apiError;
    }
  }

  private async doCallSendApi(
    psid: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pageAccessToken = this.configService.get<string>('PAGE_ACCESS_TOKEN');
    const graphApiVersion =
      this.configService.get<string>('GRAPH_API_VERSION') ?? 'v21.0';
    const sendApiTimeoutMs = this.sendApiTimeoutMs;

    if (!pageAccessToken) {
      throw new InternalServerErrorException('PAGE_ACCESS_TOKEN is missing');
    }

    const url = new URL(
      `https://graph.facebook.com/${graphApiVersion}/me/messages`,
    );
    let response: Response;
    try {
      response = await keepAliveFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pageAccessToken}`,
        },
        body: JSON.stringify({
          recipient: {
            id: psid,
          },
          ...payload,
        }),
        timeoutMs: sendApiTimeoutMs,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new MessengerApiError(
          `Messenger Send API timed out for PSID ${maskExternalId(
            psid,
          )} after ${sendApiTimeoutMs}ms`,
          408,
          'Request Timeout',
          '',
        );
      }
      throw error;
    }

    if (!response.ok) {
      const body = maskExternalIdInText(await readResponseText(response), psid);
      throw new MessengerApiError(
        `Messenger Send API failed for PSID ${maskExternalId(
          psid,
        )}: HTTP ${response.status} ${response.statusText} - ${body}`,
        response.status,
        response.statusText,
        body,
      );
    }
  }
}
