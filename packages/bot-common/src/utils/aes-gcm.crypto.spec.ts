import { randomBytes } from 'crypto';
import {
  parseEncryptionKey,
  encryptAesGcm,
  decryptAesGcm,
} from './aes-gcm.crypto';

describe('aes-gcm.crypto', () => {
  const validKey = randomBytes(32);
  const validKeyB64 = validKey.toString('base64');

  describe('parseEncryptionKey', () => {
    it('parses valid 32-byte base64 key', () => {
      const parsed = parseEncryptionKey(validKeyB64, 'TEST_KEY');
      expect(parsed.length).toBe(32);
      expect(parsed).toEqual(validKey);
    });

    it('throws when key is missing or empty', () => {
      expect(() => parseEncryptionKey(undefined, 'TEST_KEY')).toThrow(
        'TEST_KEY must be set in environment',
      );
      expect(() => parseEncryptionKey('', 'TEST_KEY')).toThrow(
        'TEST_KEY must be set in environment',
      );
    });

    it('throws when key is not 32 bytes', () => {
      const shortKeyB64 = Buffer.from('short-key').toString('base64');
      expect(() => parseEncryptionKey(shortKeyB64, 'TEST_KEY')).toThrow(
        'TEST_KEY must decode to a 32-byte key (got 9 bytes)',
      );
    });
  });

  describe('encryptAesGcm and decryptAesGcm', () => {
    it('encrypts and decrypts round-trip successfully', () => {
      const plaintext = 'test-token-value-12345';
      const ciphertext = encryptAesGcm(plaintext, validKey);

      expect(ciphertext.startsWith('v1.')).toBe(true);
      expect(ciphertext.split('.').length).toBe(4);

      const decrypted = decryptAesGcm(ciphertext, validKey);
      expect(decrypted).toBe(plaintext);
    });

    it('produces unique ciphertexts for the same plaintext due to random IVs', () => {
      const plaintext = 'repeat-text';
      const c1 = encryptAesGcm(plaintext, validKey);
      const c2 = encryptAesGcm(plaintext, validKey);

      expect(c1).not.toBe(c2);
      expect(decryptAesGcm(c1, validKey)).toBe(plaintext);
      expect(decryptAesGcm(c2, validKey)).toBe(plaintext);
    });

    it('fails closed when envelope is missing v1 prefix', () => {
      expect(() =>
        decryptAesGcm('legacy_plaintext_value', validKey, 'token'),
      ).toThrow('token is not encrypted (missing v1. prefix)');
    });

    it('fails closed when envelope structure is invalid', () => {
      expect(() =>
        decryptAesGcm('v1.invalid_envelope', validKey, 'token'),
      ).toThrow('token has an invalid encrypted envelope');
    });

    it('fails closed when decryption fails with a different key', () => {
      const ciphertext = encryptAesGcm('secret', validKey);
      const wrongKey = randomBytes(32);

      expect(() => decryptAesGcm(ciphertext, wrongKey, 'token')).toThrow(
        'token decryption failed — check encryption key',
      );
    });
  });
});
