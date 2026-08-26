import {
  maskEventId,
  maskExternalId,
  maskExternalIdInText,
  sanitizeLogValue,
} from './mask-external-id';

describe('maskExternalId', () => {
  it('returns ??? for falsy input', () => {
    expect(maskExternalId(undefined)).toBe('???');
    expect(maskExternalId(null)).toBe('???');
    expect(maskExternalId('')).toBe('???');
  });

  it('truncates short ids to first 2 chars', () => {
    expect(maskExternalId('1234567890')).toBe('12…');
  });

  it('keeps first 4 + last 4 for longer ids', () => {
    expect(maskExternalId('12345678901234')).toBe('1234…1234');
  });

  it('never contains the full id in the output', () => {
    const id = '98765432109876543210';
    const masked = maskExternalId(id);
    expect(masked).not.toContain(id);
    expect(masked).toContain('9876');
    expect(masked).toContain('3210');
  });

  it('masks numeric ids (WISPACE userId)', () => {
    expect(maskExternalId(123456789012)).toBe('1234…9012');
  });
});

describe('maskEventId', () => {
  it('returns the event id unchanged when no external id is embedded', () => {
    expect(maskEventId('mid.123456789', 'user-1')).toBe('mid.123456789');
    expect(maskEventId('pb:user-1:GET_STARTED:1699000000000', null)).toBe(
      'pb:user-1:GET_STARTED:1699000000000',
    );
    expect(maskEventId('pb:user-1:GET_STARTED:1699000000000', '')).toBe(
      'pb:user-1:GET_STARTED:1699000000000',
    );
  });

  it('masks the embedded external id in the log representation', () => {
    const eventId = 'pb:12345678901234:GET_STARTED:1699000000000';
    const masked = maskEventId(eventId, '12345678901234');
    expect(masked).toBe('pb:1234…1234:GET_STARTED:1699000000000');
    expect(masked).not.toContain('12345678901234');
  });

  it('keeps the original event id untouched (dedupe key must not change)', () => {
    const eventId = 'evt:12345678901234:1699000000000';
    maskEventId(eventId, '12345678901234');
    expect(eventId).toBe('evt:12345678901234:1699000000000');
  });
});

describe('maskExternalIdInText', () => {
  it('masks every occurrence of the external id in text', () => {
    expect(
      maskExternalIdInText(
        'failed for psid-1234567890; retrying psid-1234567890',
        'psid-1234567890',
      ),
    ).toBe('failed for psid…7890; retrying psid…7890');
  });

  it('leaves text unchanged when no external id is supplied', () => {
    expect(maskExternalIdInText('failed for unknown', null)).toBe(
      'failed for unknown',
    );
  });
});

describe('sanitizeLogValue', () => {
  it('strips control characters and keeps the printable text', () => {
    expect(sanitizeLogValue('a\u0007b\u001b[2Jc\u0000d')).toBe('a?b?[2Jc?d');
  });

  it('caps the length of untrusted log values', () => {
    expect(sanitizeLogValue('x'.repeat(300), 100)).toHaveLength(100);
    expect(sanitizeLogValue('hello', 100)).toBe('hello');
  });

  it('passes through plain values unchanged', () => {
    expect(sanitizeLogValue('plain username')).toBe('plain username');
  });
});
