import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { ValueTransformer } from 'typeorm';

/**
 * AES-256-GCM at-rest encryption for Zalo OA tokens (access + refresh).
 * Envelope format: `v1.<iv-base64>.<tag-base64>.<cipher-base64>` with a fresh
 * random IV per value. Key comes from ZALO_TOKEN_ENCRYPTION_KEY (32-byte
 * base64, managed via Doppler). Values without the `v1.` prefix are treated
 * as unencrypted legacy rows and fail closed — operators must re-bootstrap
 * the OA token pair (see docs). A changed/missing key makes decryption fail
 * loudly instead of silently returning garbage.
 */
const PREFIX = 'v1.';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_ENV = 'ZALO_TOKEN_ENCRYPTION_KEY';

function getEncryptionKey(): Buffer {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) {
    throw new Error(
      `${KEY_ENV} must be set in .env (32-byte key encoded in base64)`,
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `${KEY_ENV} must decode to a 32-byte key (got ${key.length} bytes)`,
    );
  }
  return key;
}

export function encryptOaToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.')
  );
}

export function decryptOaToken(value: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error(
      'zalo_oa_tokens value is not encrypted (missing v1 prefix) — re-bootstrap the OA token pair with a fresh access/refresh token',
    );
  }

  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new Error(
      'zalo_oa_tokens value has an invalid encrypted envelope — re-bootstrap the OA token pair',
    );
  }

  try {
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      getEncryptionKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'zalo_oa_tokens decryption failed — check ZALO_TOKEN_ENCRYPTION_KEY and re-bootstrap the OA token pair if the key was rotated',
    );
  }
}

export const oaTokenColumnTransformer: ValueTransformer = {
  to: (value?: string | null) => (value ? encryptOaToken(value) : value),
  from: (value?: string | null) => (value ? decryptOaToken(value) : value),
};
