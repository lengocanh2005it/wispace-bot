/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- jest.fn() mocks */
import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ZaloWebhookController } from './zalo-webhook.controller';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookDispatchService } from '../../application/zalo-webhook-dispatch.service';
import type { PlatformWebhookInboundEventService } from '@wispace/database';

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

describe('ZaloWebhookController (durable webhook ingestion)', () => {
  const appId = 'app-1';
  const appSecretKey = 'app-secret';
  const config = {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: appId, ZALO_APP_SECRET_KEY: appSecretKey })[key],
    get: () => undefined,
  } as unknown as ConfigService;

  const buildService = () => {
    const handleIncomingMessage = jest.fn().mockResolvedValue(undefined);
    const handleFollow = jest.fn().mockResolvedValue(undefined);
    const handleUnsupportedMessage = jest.fn().mockResolvedValue(undefined);
    const dispatcher = new ZaloWebhookDispatchService({
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage,
    } as never);
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformWebhookInboundEventService;
    const controller = new ZaloWebhookController(
      config,
      dispatcher,
      inboundEvents,
    );
    return {
      controller,
      inboundEvents,
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage,
    };
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

  it('rejects a request with an invalid signature before persisting', async () => {
    const { controller, inboundEvents } = buildService();

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
    expect(inboundEvents.ingest).not.toHaveBeenCalled();
  });

  it('persists the event before dispatch and marks it completed', async () => {
    const { controller, inboundEvents, handleIncomingMessage } = buildService();

    await callWebhook(controller, {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: String(Date.now()),
    });

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'm1',
        externalUserId: 'user-1',
        eventType: 'user_send_text',
      }),
    );
    expect(handleIncomingMessage).toHaveBeenCalledWith('user-1', 'hello', 'm1');
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(7);
  });

  it('skips duplicate deliveries without dispatch (idempotent)', async () => {
    const { controller, inboundEvents, handleIncomingMessage } = buildService();
    inboundEvents.ingest.mockResolvedValue({ inserted: false });

    await callWebhook(controller, {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: String(Date.now()),
    });

    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
  });

  it('records a bounded-backoff failure when dispatch throws', async () => {
    const { controller, inboundEvents, handleIncomingMessage } = buildService();
    handleIncomingMessage.mockRejectedValue(new Error('WISPACE down'));

    await callWebhook(controller, {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: String(Date.now()),
    });

    expect(inboundEvents.markFailed).toHaveBeenCalledWith(
      7,
      'WISPACE down',
      expect.objectContaining({ maxRetries: 5, baseRetryMs: 60_000 }),
    );
  });

  it('persists follow events with a stable composite id', async () => {
    const { controller, inboundEvents, handleFollow } = buildService();

    await callWebhook(controller, {
      app_id: appId,
      event_name: 'follow',
      follower: { id: 'user-2' },
      timestamp: String(Date.now()),
    });

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(/^follow:user-2:\d+$/),
        externalUserId: 'user-2',
      }),
    );
    expect(handleFollow).toHaveBeenCalledWith('user-2');
  });

  it('propagates a persistence failure so the endpoint does not acknowledge', async () => {
    const { controller, inboundEvents, handleIncomingMessage } = buildService();
    inboundEvents.ingest.mockRejectedValue(new Error('DB down'));

    await expect(
      callWebhook(controller, {
        app_id: appId,
        event_name: 'user_send_text',
        sender: { id: 'user-1' },
        message: { text: 'hello', msg_id: 'm1' },
        timestamp: String(Date.now()),
      }),
    ).rejects.toThrow('DB down');
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });
});
