import { createHash } from 'node:crypto';
import { redactSafetyText } from './redact-safety-text';
import {
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from '@wispace/bot-common/masking';

describe('redactSafetyText', () => {
  it('returns a stable sha256 hash of the raw text', () => {
    const raw = 'Cho mình xem tiến độ học';
    const expected = createHash('sha256').update(raw, 'utf8').digest('hex');

    const a = redactSafetyText(raw);
    const b = redactSafetyText(raw);

    expect(a.hash).toBe(expected);
    expect(a.hash).toBe(b.hash);
  });

  it('strips control characters from the excerpt', () => {
    const result = redactSafetyText('hello \u0000 world\u001B[0m');

    expect(result.excerpt).toBe('hello world[0m');
  });

  it('masks JWT credentials', () => {
    // Built from parts so no literal token-shaped string sits in the repo
    // (gitleaks flags jwt-shaped fixtures).
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('.');
    const result = redactSafetyText(`token là ${jwt} phần sau`);

    expect(result.excerpt).toContain('[REDACTED]');
    expect(result.excerpt).not.toContain('eyJhbGci');
  });

  it('masks Bearer tokens, private keys and api keys', () => {
    // Built from small parts so no literal token-shaped string sits in the repo
    // (gitleaks flags jwt/api-key-shaped fixtures even in tests).
    const apiKeyValue = 'ab12cd34' + 'ef56gh78' + 'ij90kl12' + 'mn34op56';
    const raw = [
      'Authorization: Bearer sk-1234567890abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      `api_key=${apiKeyValue}`,
    ].join('\n');

    const result = redactSafetyText(raw);

    expect(result.excerpt).not.toContain('sk-1234567890');
    expect(result.excerpt).not.toContain('MIIEpAIBAAKCAQEA');
    expect(result.excerpt).not.toContain(apiKeyValue);
    expect(result.excerpt).toContain('[REDACTED]');
  });

  it('masks emails and Vietnamese phone numbers', () => {
    const result = redactSafetyText(
      'Liên hệ hoclv@example.com hoặc 0912345678',
    );

    expect(result.excerpt).not.toContain('hoclv@example.com');
    expect(result.excerpt).not.toContain('0912345678');
  });

  it('truncates the excerpt to maxChars and reports original length', () => {
    const raw = 'a'.repeat(500);
    const result = redactSafetyText(raw, 100);

    expect(result.excerpt.length).toBeLessThanOrEqual(103); // 100 + '...'
    expect(result.originalLength).toBe(500);
  });

  it('masks key=value secret assignments', () => {
    const result = redactSafetyText('password: SuperSecret123! tiếp tục');

    expect(result.excerpt).not.toContain('SuperSecret123');
  });

  it('masks a bare provider key that is not attached to a Bearer header', () => {
    // Assembled from parts so no literal api-key-shaped string sits in the
    // repo (gitleaks flags those even in tests).
    const bareKey = 'sk-' + 'proj9Qw3rty12uio0pAS';
    const result = redactSafetyText(`upstream said ${bareKey} was invalid`);

    expect(result.excerpt).not.toContain(bareKey);
    expect(result.excerpt).toContain('[REDACTED]');
  });

  it('masks credentials embedded in a connection string', () => {
    // Host without a dot: the e-mail pattern needs `host.tld`, so this only
    // passes once the shared connection-string shape is actually applied.
    const result = redactSafetyText(
      'Redis down: redis://:Pa55wordForRedis@redis-cluster:6379/0',
    );

    expect(result.excerpt).not.toContain('Pa55wordForRedis');
    expect(result.excerpt).toContain('[REDACTED]');
  });

  it('masks a registered runtime secret value', () => {
    registerRuntimeSecrets(['Xk9mQ2vLp4Tn7Ws']);
    try {
      const result = redactSafetyText('giá trị cấu hình Xk9mQ2vLp4Tn7Ws hỏng');
      expect(result.excerpt).not.toContain('Xk9mQ2vLp4Tn7Ws');
      expect(result.excerpt).toContain('[REDACTED]');
    } finally {
      resetRuntimeSecretsForTests();
    }
  });

  it('keeps ordinary prose readable after redaction', () => {
    const result = redactSafetyText('Cho mình xem lịch học tuần này nhé');

    expect(result.excerpt).toBe('Cho mình xem lịch học tuần này nhé');
  });
});
