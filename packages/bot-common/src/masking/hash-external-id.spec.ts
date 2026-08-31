import { hashExternalId, truncatePersistedError } from './hash-external-id';

describe('hashExternalId', () => {
  it('returns a 64-char lowercase hex sha256', () => {
    const hash = hashExternalId('psid-1');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashExternalId('psid-1')).toBe(hashExternalId('psid-1'));
  });

  it('differs for different inputs', () => {
    expect(hashExternalId('psid-1')).not.toBe(hashExternalId('psid-2'));
  });

  it('matches Node crypto sha256 hex (cross-check with pg encode(sha256))', () => {
    // pg: encode(sha256(convert_to('psid-1','UTF8')),'hex')
    expect(hashExternalId('psid-1')).toBe(
      'ef300f8180c1c183469749e878bdb3f5322e44ab6d14ddb543dcfcfe8e7d6bd3',
    );
  });

  it('returns empty string for falsy input', () => {
    expect(hashExternalId('')).toBe('');
    expect(hashExternalId(undefined)).toBe('');
    expect(hashExternalId(null)).toBe('');
  });
});

describe('truncatePersistedError', () => {
  afterEach(() => {
    delete process.env.PERSISTED_ERROR_MAX_CHARS;
  });

  it('returns null for falsy input', () => {
    expect(truncatePersistedError(null)).toBeNull();
    expect(truncatePersistedError(undefined)).toBeNull();
    expect(truncatePersistedError('')).toBeNull();
  });

  it('returns short text unchanged', () => {
    expect(truncatePersistedError('boom')).toBe('boom');
  });

  it('truncates to 2000 chars by default', () => {
    const long = 'x'.repeat(3000);
    const result = truncatePersistedError(long);
    expect(result).toHaveLength(2000);
  });

  it('honors PERSISTED_ERROR_MAX_CHARS override', () => {
    process.env.PERSISTED_ERROR_MAX_CHARS = '100';
    expect(truncatePersistedError('x'.repeat(150))).toHaveLength(100);
  });

  it('falls back to default on invalid override', () => {
    process.env.PERSISTED_ERROR_MAX_CHARS = 'not-a-number';
    expect(truncatePersistedError('x'.repeat(3000))).toHaveLength(2000);
  });

  it('falls back to default on zero/negative override', () => {
    process.env.PERSISTED_ERROR_MAX_CHARS = '0';
    expect(truncatePersistedError('x'.repeat(3000))).toHaveLength(2000);
  });

  it('accepts an explicit cap argument (no env read)', () => {
    expect(truncatePersistedError('abcdef', 3)).toBe('abc');
  });
});
