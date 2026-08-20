import { errorMessage, sanitizeErrorStack } from './error-message';

describe('errorMessage', () => {
  it('extracts message from standard Error', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('handles string errors', () => {
    expect(errorMessage('plain string error')).toBe('plain string error');
  });

  it('handles null and undefined', () => {
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage(undefined)).toBe('Unknown error');
  });

  it('handles objects with message property', () => {
    expect(errorMessage({ message: 'custom obj error' })).toBe(
      'custom obj error',
    );
    expect(errorMessage({ other: 'value' })).toBe('Unknown error');
  });

  it('handles numbers and booleans', () => {
    expect(errorMessage(404)).toBe('404');
    expect(errorMessage(false)).toBe('false');
  });

  it('strips control characters and newlines to prevent log injection', () => {
    const malicious =
      'Error on line 1\r\n[2026-08-20] FAKE LOG LINE\x00\x1b[31m';
    const result = errorMessage(new Error(malicious));
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\x00');
    expect(result).toBe('Error on line 1 [2026-08-20] FAKE LOG LINE [31m');
  });

  it('redacts Bearer tokens', () => {
    const msg =
      'Request failed with header Authorization: Bearer eyJhbGciOi.secret.token';
    expect(errorMessage(msg)).toBe(
      'Request failed with header Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts sensitive key-value pairs', () => {
    expect(errorMessage('failed with password=supersecret123')).toBe(
      'failed with password=[REDACTED]',
    );
    expect(errorMessage('config error: api_key="secret-key-xyz"')).toBe(
      'config error: api_key="[REDACTED]"',
    );
    expect(errorMessage("auth error: token: 'tok-123456'")).toBe(
      "auth error: token: '[REDACTED]'",
    );
    expect(
      errorMessage('internal key mismatch: X-Internal-Key: key_12345'),
    ).toBe('internal key mismatch: X-Internal-Key: [REDACTED]');
    expect(errorMessage('secret=sensitive-data and credential=cred-val')).toBe(
      'secret=[REDACTED] and credential=[REDACTED]',
    );
  });

  it('redacts URL query secrets', () => {
    const urlError =
      'GET https://api.wispace.com/v1/sync?token=secret123&apiKey=key456&user=10 failed';
    const result = errorMessage(urlError);
    expect(result).toBe(
      'GET https://api.wispace.com/v1/sync?token=[REDACTED]&apiKey=[REDACTED]&user=10 failed',
    );
  });

  it('redacts connection URI credentials', () => {
    const dbError =
      'Connection failed: postgres://postgres:myPassword123@db.internal:5432/ai_chat_bot_db';
    expect(errorMessage(dbError)).toBe(
      'Connection failed: postgres://[REDACTED]@db.internal:5432/ai_chat_bot_db',
    );

    const redisError = 'Redis down: redis://:mypassword@redis-cluster:6379/0';
    expect(errorMessage(redisError)).toBe(
      'Redis down: redis://[REDACTED]@redis-cluster:6379/0',
    );
  });

  it('redacts standalone JWT tokens', () => {
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'doNotLeakThisSignature123',
    ].join('.');
    expect(errorMessage(`Invalid session: ${jwt}`)).toBe(
      'Invalid session: [REDACTED]',
    );
  });

  it('masks external IDs when provided', () => {
    const psid = '123456789012345';
    expect(errorMessage(`Failed for user ${psid}`, psid)).toBe(
      'Failed for user 1234…2345',
    );
    expect(
      errorMessage(`Failed for user ${psid}`, { externalUserId: psid }),
    ).toBe('Failed for user 1234…2345');
  });

  it('limits message length', () => {
    const longMessage = 'A'.repeat(1000);
    const result = errorMessage(longMessage);
    expect(result.length).toBe(500);

    const customCap = errorMessage(longMessage, { maxChars: 50 });
    expect(customCap.length).toBe(50);
  });
});

describe('sanitizeErrorStack', () => {
  it('returns undefined for non-strings or falsy inputs', () => {
    expect(sanitizeErrorStack(undefined)).toBeUndefined();
    expect(sanitizeErrorStack('')).toBeUndefined();
  });

  it('preserves newlines in stack trace while redacting secrets', () => {
    const stack =
      'Error: connect ECONNREFUSED postgres://user:secret@localhost:5432\n' +
      '    at TCPConnectWrap.afterConnect (net.js:1146:16)\n' +
      '    at token=xyz123 (auth.js:10:5)';

    const sanitized = sanitizeErrorStack(stack);
    expect(sanitized).toContain('\n');
    expect(sanitized).toContain('postgres://[REDACTED]@localhost:5432');
    expect(sanitized).toContain('token=[REDACTED]');
    expect(sanitized).not.toContain('secret');
    expect(sanitized).not.toContain('xyz123');
  });

  it('removes non-newline control characters from stack traces', () => {
    const stack = 'before\rAFTER\tTAB\n' + '    at frame (file.js:1:1)';

    const sanitized = sanitizeErrorStack(stack);
    expect(sanitized).not.toContain('\r');
    expect(sanitized).not.toContain('\t');
    expect(sanitized).toContain('\n');
  });

  it('caps max stack trace length', () => {
    const hugeStack = 'Error: boom\n' + ' at frame (file.js:1:1)\n'.repeat(200);
    const sanitized = sanitizeErrorStack(hugeStack, 100);
    expect(sanitized?.length).toBe(101); // 100 + '…'
    expect(sanitized?.endsWith('…')).toBe(true);
  });
});
