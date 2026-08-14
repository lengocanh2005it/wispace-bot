import {
  decryptOaToken,
  encryptOaToken,
  oaTokenColumnTransformer,
} from './oa-token-crypto.transformer';

const KEY_ENV = 'ZALO_TOKEN_ENCRYPTION_KEY';
const VALID_KEY = Buffer.from('z'.repeat(32), 'utf8').toString('base64');

describe('oa-token-crypto', () => {
  const originalKey = process.env[KEY_ENV];

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env[KEY_ENV];
    } else {
      process.env[KEY_ENV] = originalKey;
    }
  });

  it('encrypts and decrypts a token round-trip', () => {
    process.env[KEY_ENV] = VALID_KEY;

    const ciphertext = encryptOaToken('plain-access-token');
    expect(ciphertext).toMatch(/^v1\./);
    expect(ciphertext).not.toContain('plain-access-token');
    expect(decryptOaToken(ciphertext)).toBe('plain-access-token');
  });

  it('uses a fresh IV per encryption', () => {
    process.env[KEY_ENV] = VALID_KEY;

    const first = encryptOaToken('same-value');
    const second = encryptOaToken('same-value');
    expect(first).not.toBe(second);
  });

  it('fails closed on a legacy plaintext value (no v1 prefix)', () => {
    process.env[KEY_ENV] = VALID_KEY;

    expect(() => decryptOaToken('legacy-plaintext-token')).toThrow(
      'not encrypted',
    );
  });

  it('fails on a tampered ciphertext', () => {
    process.env[KEY_ENV] = VALID_KEY;

    const ciphertext = encryptOaToken('secret-token');
    const tampered =
      ciphertext.slice(0, -2) + (ciphertext.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptOaToken(tampered)).toThrow('decryption failed');
  });

  it('fails when the key does not match', () => {
    process.env[KEY_ENV] = VALID_KEY;
    const ciphertext = encryptOaToken('secret-token');

    process.env[KEY_ENV] = Buffer.from('a'.repeat(32), 'utf8').toString(
      'base64',
    );
    expect(() => decryptOaToken(ciphertext)).toThrow('decryption failed');
  });

  it('fails when the key is missing or not 32 bytes', () => {
    delete process.env[KEY_ENV];
    expect(() => encryptOaToken('token')).toThrow(
      'ZALO_TOKEN_ENCRYPTION_KEY must be set',
    );

    process.env[KEY_ENV] = Buffer.from('short', 'utf8').toString('base64');
    expect(() => encryptOaToken('token')).toThrow('32-byte key');
  });

  it('transformer passes null/undefined through untouched', () => {
    expect(oaTokenColumnTransformer.to(undefined)).toBeUndefined();
    expect(oaTokenColumnTransformer.to(null)).toBeNull();
    expect(oaTokenColumnTransformer.from(undefined)).toBeUndefined();
    expect(oaTokenColumnTransformer.from(null)).toBeNull();
  });

  it('transformer encrypts on write and decrypts on read', () => {
    process.env[KEY_ENV] = VALID_KEY;

    const stored = oaTokenColumnTransformer.to('plain') as string;
    expect(stored).toMatch(/^v1\./);
    expect(oaTokenColumnTransformer.from(stored)).toBe('plain');
  });
});
