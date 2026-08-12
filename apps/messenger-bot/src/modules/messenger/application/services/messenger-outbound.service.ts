import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common';
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

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly repository: MessengerMessageLogRepositoryPort,
  ) {
    this.sendBreaker = new CircuitBreaker(
      async (psid: string, payload: Record<string, unknown>) => {
        await this.doCallSendApi(psid, payload);
      },
      {
        timeout: 10_000,
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
  }): Promise<number> {
    const defaults = readMessengerBubbleLimits(this.configService);
    const bubbles = splitMessengerBubbles(
      params.text,
      params.maxBubbles ?? defaults.maxBubbles,
      params.maxCharsPerBubble ?? defaults.maxCharsPerBubble,
    );

    if (!bubbles.length) {
      return 0;
    }

    let sentCount = 0;

    for (const [index, bubble] of bubbles.entries()) {
      try {
        await this.sendTextViaPsid({
          psid: params.psid,
          userId: params.userId,
          text: bubble,
          messageType:
            bubbles.length > 1
              ? `${params.messageType}_PART_${index + 1}_OF_${bubbles.length}`
              : params.messageType,
        });
        sentCount += 1;
      } catch (error) {
        const apiError = this.toMessengerApiError(params.psid, error);
        if (sentCount > 0) {
          throw new MessengerPartialSendError(sentCount, apiError);
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
  }): Promise<void> {
    for (const followUp of params.followUps) {
      if (followUp.kind === 'generic') {
        await this.sendGenericTemplate({
          psid: params.psid,
          userId: params.userId,
          messageType: followUp.messageType,
          elements: followUp.elements,
        });
        continue;
      }

      await this.sendButtonTemplate({
        psid: params.psid,
        userId: params.userId,
        messageType: followUp.messageType,
        text: followUp.text,
        buttons: followUp.buttons,
      });
    }
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
  }): Promise<void> {
    if (!params.elements.length) {
      return;
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
        messageText: JSON.stringify(params.elements),
        status: 'SENT',
      });
    } catch (error) {
      const errorText = maskExternalIdInText(errorMessage(error), params.psid);
      await this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        messageText: JSON.stringify(params.elements),
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
  }): Promise<void> {
    if (!params.buttons.length) {
      return;
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
        messageText: params.text,
        status: 'SENT',
      });
    } catch (error) {
      const errorText = maskExternalIdInText(errorMessage(error), params.psid);
      void this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        messageText: params.text,
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
  }): Promise<void> {
    try {
      await this.callSendApiByPsid(params.psid, {
        message: { text: params.text },
      });
      void this.repository.logMessage({
        userId: params.userId,
        psid: params.psid,
        messageType: params.messageType,
        messageText: params.text,
        status: 'SENT',
      });
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
    input?: { messageType?: string; userId?: number },
  ): Promise<void> {
    await this.sendTextViaPsid({
      psid: externalUserId,
      text,
      messageType: input?.messageType ?? 'STUDY_REMINDER',
      userId: input?.userId,
    });
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
      messageText: params.text,
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
      throw error;
    }
  }

  private async doCallSendApi(
    psid: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const pageAccessToken = this.configService.get<string>('PAGE_ACCESS_TOKEN');
    const graphApiVersion =
      this.configService.get<string>('GRAPH_API_VERSION') ?? 'v21.0';
    const sendApiTimeoutMs =
      this.configService.get<number>('MESSENGER_SEND_API_TIMEOUT_MS') ?? 10_000;

    if (!pageAccessToken) {
      throw new InternalServerErrorException('PAGE_ACCESS_TOKEN is missing');
    }

    const url = new URL(
      `https://graph.facebook.com/${graphApiVersion}/me/messages`,
    );
    url.searchParams.set('access_token', pageAccessToken);

    let response: Response;
    try {
      response = await keepAliveFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
      const body = maskExternalIdInText(await response.text(), psid);
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
