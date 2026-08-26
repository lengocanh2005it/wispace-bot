import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const PREFIX = 'v1.';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Validates and decodes a 32-byte base64 encryption key.
 * Throws an actionable error if the key is missing or invalid.
 */
export function parseEncryptionKey(
  rawKey: string | undefined,
  keyName = 'ENCRYPTION_KEY',
): Buffer {
  const trimmed = rawKey?.trim();
  if (!trimmed) {
    throw new Error(
      `${keyName} must be set in environment (32-byte key encoded in base64)`,
    );
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `${keyName} must decode to a 32-byte key (got ${key.length} bytes)`,
    );
  }
  return key;
}

/**
 * Encrypts plaintext using AES-256-GCM with a fresh random 12-byte IV.
 * Returns envelope format: `v1.<iv-base64>.<tag-base64>.<cipher-base64>`.
 */
export function encryptAesGcm(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
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

/**
 * Decrypts a `v1.<iv-base64>.<tag-base64>.<cipher-base64>` envelope.
 * Throws actionable errors if the envelope is invalid, not prefixed with v1,
 * or if decryption/auth-tag verification fails.
 */
export function decryptAesGcm(
  value: string,
  key: Buffer,
  contextName = 'encrypted value',
): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error(
      `${contextName} is not encrypted (missing ${PREFIX} prefix)`,
    );
  }

  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new Error(`${contextName} has an invalid encrypted envelope`);
  }

  try {
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(`${contextName} decryption failed — check encryption key`);
  }
}
