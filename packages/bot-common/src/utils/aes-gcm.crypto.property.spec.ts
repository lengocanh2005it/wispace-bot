import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { decryptAesGcm, encryptAesGcm } from './aes-gcm.crypto';

fc.configureGlobal({ numRuns: 200 });

const KEY = fc
  .array(fc.integer({ min: 0, max: 255 }), {
    minLength: 32,
    maxLength: 32,
  })
  .map((bytes) => Buffer.from(bytes));

describe('AES-GCM properties', () => {
  it('round-trips arbitrary Unicode plaintext with valid keys', () => {
    fc.assert(
      fc.property(KEY, fc.string(), (key, plaintext) => {
        const encrypted = encryptAesGcm(plaintext, key);
        expect(decryptAesGcm(encrypted, key)).toBe(plaintext);
      }),
    );
  });

  it('rejects a ciphertext with a changed authentication tag', () => {
    fc.assert(
      fc.property(KEY, fc.string(), (key, plaintext) => {
        const parts = encryptAesGcm(plaintext, key).split('.');
        const tag = Buffer.from(parts[2] ?? '', 'base64');
        tag[0] = (tag[0] ?? 0) ^ 1;
        parts[2] = tag.toString('base64');

        expect(() => decryptAesGcm(parts.join('.'), key)).toThrow(
          'decryption failed',
        );
      }),
    );
  });

  it('rejects a ciphertext with a different valid key', () => {
    fc.assert(
      fc.property(KEY, fc.string(), (key, plaintext) => {
        const wrongKey = Buffer.from(key);
        wrongKey[0] = (wrongKey[0] ?? 0) ^ 1;

        expect(() =>
          decryptAesGcm(encryptAesGcm(plaintext, key), wrongKey),
        ).toThrow('decryption failed');
      }),
    );
  });

  it('does not reuse the random IV for identical plaintext', () => {
    const key = randomBytes(32);
    fc.assert(
      fc.property(fc.string(), (plaintext) => {
        expect(encryptAesGcm(plaintext, key)).not.toBe(
          encryptAesGcm(plaintext, key),
        );
      }),
    );
  });
});
