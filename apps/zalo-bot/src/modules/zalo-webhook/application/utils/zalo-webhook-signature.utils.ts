import { createHash, timingSafeEqual } from 'crypto';

const MAX_WEBHOOK_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isZaloWebhookTimestampFresh(
  timestamp: string,
  nowMs = Date.now(),
): boolean {
  const timestampMs = Number(timestamp);
  return (
    Number.isFinite(timestampMs) &&
    Math.abs(nowMs - timestampMs) <= MAX_WEBHOOK_CLOCK_SKEW_MS
  );
}

/**
 * Zalo webhook signature: mac = sha256(appId + rawBody + timestamp + appSecretKey).
 * Header name is `X-ZEvent-Signature` (see zalo-webhook.controller.ts).
 * Zalo has a single app secret key (developers.zalo.me > Cài đặt > "Khóa bí
 * mật của ứng dụng") — used for both OAuth and webhook signature, no
 * separate "OA secret key" exists.
 */
export function verifyZaloWebhookSignature(params: {
  appId: string;
  rawBody: string;
  timestamp: string;
  appSecretKey: string;
  signatureHeader: string | undefined;
}): boolean {
  const { appId, rawBody, timestamp, appSecretKey, signatureHeader } = params;

  if (!signatureHeader) {
    return false;
  }

  const expected = createHash('sha256')
    .update(appId + rawBody + timestamp + appSecretKey)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}
