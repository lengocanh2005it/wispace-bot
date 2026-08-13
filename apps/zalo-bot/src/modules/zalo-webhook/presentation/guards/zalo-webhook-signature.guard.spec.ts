import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ZaloWebhookSignatureGuard } from './zalo-webhook-signature.guard';

function contextFor(params: {
  body: Record<string, unknown>;
  rawBody: Buffer;
  signature?: string;
  timestamp?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        body: params.body,
        rawBody: params.rawBody,
        header: (name: string) =>
          name === 'x-zevent-signature'
            ? params.signature
            : name === 'x-zevent-timestamp'
              ? params.timestamp
              : undefined,
      }),
    }),
  } as ExecutionContext;
}

describe('ZaloWebhookSignatureGuard', () => {
  const appId = 'app-1';
  const appSecretKey = 'secret-1';
  const body = { app_id: appId, event_name: 'user_send_text' };
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const signature = createHash('sha256')
    .update(appId + rawBody.toString('utf8') + timestamp + appSecretKey)
    .digest('hex');
  const config = {
    getOrThrow: (key: string) => (key === 'ZALO_APP_ID' ? appId : appSecretKey),
  } as unknown as ConfigService;

  it('allows a valid signed and fresh request', () => {
    const guard = new ZaloWebhookSignatureGuard(config);

    expect(
      guard.canActivate(contextFor({ body, rawBody, signature, timestamp })),
    ).toBe(true);
  });

  it('rejects invalid signatures before dispatch', () => {
    const guard = new ZaloWebhookSignatureGuard(config);

    expect(() =>
      guard.canActivate(
        contextFor({ body, rawBody, signature: 'invalid', timestamp }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects stale signed requests', () => {
    const guard = new ZaloWebhookSignatureGuard(config);
    const staleTimestamp = String(Date.now() - 10 * 60 * 1000);
    const staleSignature = createHash('sha256')
      .update(appId + rawBody.toString('utf8') + staleTimestamp + appSecretKey)
      .digest('hex');

    expect(() =>
      guard.canActivate(
        contextFor({
          body,
          rawBody,
          signature: staleSignature,
          timestamp: staleTimestamp,
        }),
      ),
    ).toThrow(UnauthorizedException);
  });
});
