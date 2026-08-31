import { RedactedLogger, redactLogLine } from './redacted-logger';

function capture(): { lines: string[]; logger: RedactedLogger } {
  const lines: string[] = [];
  const logger = new RedactedLogger({
    write: (_level, line) => lines.push(String(line)),
  });
  return { lines, logger };
}

describe('redactLogLine (#610 digit-run external-id masking)', () => {
  it('masks long digit runs (PSID 15+ / Discord snowflake 17-19)', () => {
    const out = redactLogLine(
      'Linked Discord account discordUserId=12345678901234567 userId=9876543210123456',
    );
    expect(out).not.toContain('12345678901234567');
    expect(out).not.toContain('9876543210123456');
    expect(out).toMatch(/discordUserId=12…67\(17\)/);
    expect(out).toMatch(/userId=98…56\(16\)/);
  });

  it('keeps short and mid-length digit runs (epoch-ms 13, ports, counts)', () => {
    const input =
      'Report sent in 512ms ts=1700000000000 port=3000 used=42/50 jobId=1234567890123';
    expect(redactLogLine(input)).toBe(input);
  });

  it('does not double-mask an already-masked id', () => {
    const input = 'psid=ps…45(15) normal line';
    expect(redactLogLine(input)).toBe(input);
  });

  it('keeps [REDACTED] placeholders from errorMessage masking intact', () => {
    const input = 'auth failed: Bearer [REDACTED] at /v1/goals';
    expect(redactLogLine(input)).toBe(input);
  });

  it('masks digit runs embedded in longer tokens but not hex/uuid', () => {
    const out = redactLogLine(
      'mid=111222333444555666 event=ok id=550e8400-e29b-41d4-a716-446655440000',
    );
    expect(out).not.toContain('111222333444555666');
    // UUID digits are not a single digit-run (hex letters break it up).
    expect(out).toContain('550e8400-e29b-41d4-a716-446655440000');
  });
});

describe('RedactedLogger (captured transport)', () => {
  it('routes log/warn/error/debug through redaction', () => {
    const { lines, logger } = capture();

    logger.log('psid raw 123456789012345678');
    logger.warn('warn raw 123456789012345678');
    logger.error('error raw 123456789012345678', 'STACK TRACE');
    logger.debug('debug raw 123456789012345678');

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).not.toContain('123456789012345678');
    }
    expect(lines.join('\n')).toContain('STACK TRACE');
  });

  it('preserves context labels on every level', () => {
    const { lines, logger } = capture();

    logger.log('hello', undefined, 'MyService');
    logger.error('boom', undefined, 'MyService');

    expect(lines[0]).toContain('[MyService]');
    expect(lines[1]).toContain('[MyService]');
  });

  it('passes non-string messages through untouched (objects, errors)', () => {
    const { lines, logger } = capture();
    const err = new Error('boom');

    logger.log(err);
    logger.warn({ some: 'object' });

    expect(lines[0]).toBe('Error: boom');
    expect(lines[1]).toBe('[object Object]');
  });

  it('keeps the default console transport when none is injected', () => {
    const logger = new RedactedLogger();
    // Must not throw — writes to real console.
    expect(() => logger.log('ok')).not.toThrow();
  });
});
