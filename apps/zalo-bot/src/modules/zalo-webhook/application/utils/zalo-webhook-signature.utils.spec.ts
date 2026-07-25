import { createHash } from 'crypto';
import { verifyZaloWebhookSignature } from './zalo-webhook-signature.utils';

function buildSignature(
  appId: string,
  rawBody: string,
  timestamp: string,
  secret: string,
): string {
  return createHash('sha256')
    .update(appId + rawBody + timestamp + secret)
    .digest('hex');
}

describe('verifyZaloWebhookSignature', () => {
  const appId = 'app-1';
  const rawBody = '{"event_name":"user_send_text"}';
  const timestamp = '1690000000000';
  const secret = 'oa-secret';

  it('returns true for a correctly computed signature', () => {
    const signatureHeader = buildSignature(appId, rawBody, timestamp, secret);
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody,
        timestamp,
        appSecretKey: secret,
        signatureHeader,
      }),
    ).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const signatureHeader = buildSignature(appId, rawBody, timestamp, secret);
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody: '{"event_name":"user_send_image"}',
        timestamp,
        appSecretKey: secret,
        signatureHeader,
      }),
    ).toBe(false);
  });

  it('returns false when the signature header is missing', () => {
    expect(
      verifyZaloWebhookSignature({
        appId,
        rawBody,
        timestamp,
        appSecretKey: secret,
        signatureHeader: undefined,
      }),
    ).toBe(false);
  });
});
