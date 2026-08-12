import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ZaloWebhookController } from './zalo-webhook.controller';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import type { ZaloWebhookIngestService } from '../../application/zalo-webhook-ingest.service';

function buildRequest(rawBody: string): Request {
  return { rawBody: Buffer.from(rawBody, 'utf8') } as unknown as Request;
}

function sign(
  appId: string,
  rawBody: string,
  timestamp: string,
  secret: string,
) {
  return createHash('sha256')
    .update(appId + rawBody + timestamp + secret)
    .digest('hex');
}

describe('ZaloWebhookController', () => {
  const appId = 'app-1';
  const appSecretKey = 'app-secret';
  const config = {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: appId, ZALO_APP_SECRET_KEY: appSecretKey })[key],
  } as unknown as ConfigService;

  const buildService = () => {
    const processEvent = jest.fn().mockResolvedValue(undefined);
    const ingestService = {
      processEvent,
    } as unknown as ZaloWebhookIngestService;
    const controller = new ZaloWebhookController(config, ingestService);
    return { controller, processEvent };
  };

  const callWebhook = (
    controller: ZaloWebhookController,
    body: Record<string, unknown>,
  ) => {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = sign(appId, rawBody, timestamp, appSecretKey);
    return controller.handleWebhook(
      body as unknown as ZaloWebhookEvent,
      buildRequest(rawBody),
      signature,
      timestamp,
    );
  };

  it('rejects a request with an invalid signature before ingesting', async () => {
    const { controller, processEvent } = buildService();

    const body = { event_name: 'user_send_text' };
    const rawBody = JSON.stringify(body);

    await expect(
      controller.handleWebhook(
        body as unknown as ZaloWebhookEvent,
        buildRequest(rawBody),
        'wrong-signature',
        String(Date.now()),
      ),
    ).rejects.toThrow();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('rejects a stale timestamp', async () => {
    const { controller, processEvent } = buildService();

    const body = { event_name: 'user_send_text' };
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const signature = sign(appId, rawBody, timestamp, appSecretKey);

    await expect(
      controller.handleWebhook(
        body as unknown as ZaloWebhookEvent,
        buildRequest(rawBody),
        signature,
        timestamp,
      ),
    ).rejects.toThrow();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('delegates an authenticated event to the ingest service', async () => {
    const { controller, processEvent } = buildService();

    await callWebhook(controller, {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: String(Date.now()),
    });

    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it('propagates a persistence failure so the endpoint does not acknowledge', async () => {
    const { controller, processEvent } = buildService();
    processEvent.mockRejectedValue(new Error('DB down'));

    await expect(
      callWebhook(controller, {
        app_id: appId,
        event_name: 'user_send_text',
        sender: { id: 'user-1' },
        message: { text: 'hello', msg_id: 'm1' },
        timestamp: String(Date.now()),
      }),
    ).rejects.toThrow('DB down');
  });
});
