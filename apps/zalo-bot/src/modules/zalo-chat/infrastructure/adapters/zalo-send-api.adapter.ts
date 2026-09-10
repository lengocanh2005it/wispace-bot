import { Injectable } from '@nestjs/common';
import { readResponseText } from '@wispace/bot-common/utils';
import { keepAliveFetch } from '@wispace/wispace-client';
import type {
  ZaloOutboundTransportInput,
  ZaloOutboundTransportPort,
  ZaloOutboundTransportResult,
} from '../../application/ports/zalo-outbound-transport.port';

const SEND_TEXT_ENDPOINT = 'https://openapi.zalo.me/v3.0/oa/message/cs';
const SEND_TIMEOUT_MS = 10_000;

/** Zalo Send API adapter; response parsing stays outside outbound policy (#429). */
@Injectable()
export class ZaloSendApiAdapter implements ZaloOutboundTransportPort {
  async sendText(
    input: ZaloOutboundTransportInput,
  ): Promise<ZaloOutboundTransportResult> {
    const response = await keepAliveFetch(SEND_TEXT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_token: input.accessToken,
      },
      body: JSON.stringify({
        recipient: { user_id: input.recipientId },
        message: { text: input.text },
      }),
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)])
        : AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const responseBody = await readResponseText(response);
    let applicationError = 0;
    try {
      const payload = responseBody
        ? (JSON.parse(responseBody) as { error?: unknown })
        : undefined;
      if (payload && typeof payload === 'object' && 'error' in payload) {
        applicationError = Number(payload.error);
      }
    } catch {
      // The caller retains the bounded raw body for classification/logging.
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      responseBody,
      applicationError: Number.isFinite(applicationError)
        ? applicationError
        : 0,
    };
  }
}
