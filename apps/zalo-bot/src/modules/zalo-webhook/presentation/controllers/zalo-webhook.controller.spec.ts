import { createHash } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { ZaloWebhookController } from './zalo-webhook.controller';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';

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

  it('rejects a request with an invalid signature', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage: jest.fn(),
    });

    const body = { event_name: 'user_send_text' };
    const rawBody = JSON.stringify(body);
    const timestamp = '1690000000000';

    await expect(
      controller.handleWebhook(
        body as unknown as ZaloWebhookEvent,
        buildRequest(rawBody),
        'wrong-signature',
        timestamp,
      ),
    ).rejects.toThrow();
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });

  it('dispatches user_send_text to handleIncomingMessage', async () => {
    const handleIncomingMessage = jest.fn().mockResolvedValue(undefined);
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage: jest.fn(),
    });

    const body = {
      app_id: appId,
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
      message: { text: 'hello', msg_id: 'm1' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, appSecretKey);

    await controller.handleWebhook(
      body as unknown as ZaloWebhookEvent,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleIncomingMessage).toHaveBeenCalledWith('user-1', 'hello');
  });

  it('dispatches user_send_image to handleUnsupportedMessage', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn();
    const handleUnsupportedMessage = jest.fn().mockResolvedValue(undefined);
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage,
    });

    const body = {
      app_id: appId,
      event_name: 'user_send_image',
      sender: { id: 'user-3' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, appSecretKey);

    await controller.handleWebhook(
      body as unknown as ZaloWebhookEvent,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleUnsupportedMessage).toHaveBeenCalledWith('user-3');
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });

  it('dispatches follow to handleFollow', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn().mockResolvedValue(undefined);
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage: jest.fn(),
    });

    const body = {
      app_id: appId,
      event_name: 'follow',
      follower: { id: 'user-2' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, appSecretKey);

    await controller.handleWebhook(
      body as unknown as ZaloWebhookEvent,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleFollow).toHaveBeenCalledWith('user-2');
  });

  it('ignores oa_send_* echo events', async () => {
    const handleIncomingMessage = jest.fn();
    const handleFollow = jest.fn();
    const controller = new ZaloWebhookController(config, {
      handleIncomingMessage,
      handleFollow,
      handleUnsupportedMessage: jest.fn(),
    });

    const body = {
      app_id: appId,
      event_name: 'oa_send_text',
      recipient: { id: 'user-1' },
      timestamp: '1690000000000',
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(appId, rawBody, body.timestamp, appSecretKey);

    await controller.handleWebhook(
      body as unknown as ZaloWebhookEvent,
      buildRequest(rawBody),
      signature,
      body.timestamp,
    );

    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(handleFollow).not.toHaveBeenCalled();
  });
});
