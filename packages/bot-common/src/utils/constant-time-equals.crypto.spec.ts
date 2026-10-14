import { constantTimeEquals } from './constant-time-equals.crypto';

describe('bot-common/constantTimeEquals', () => {
  it('returns true for identical buffers', () => {
    expect(
      constantTimeEquals(
        Buffer.from('s3cret', 'utf8'),
        Buffer.from('s3cret', 'utf8'),
      ),
    ).toBe(true);
  });

  it('returns true for identical empty buffers', () => {
    expect(constantTimeEquals(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  });

  it('returns false for buffers of different length', () => {
    expect(
      constantTimeEquals(
        Buffer.from('s3cret', 'utf8'),
        Buffer.from('s3cre', 'utf8'),
      ),
    ).toBe(false);
  });

  it('returns false for same-length buffers with different content', () => {
    expect(
      constantTimeEquals(
        Buffer.from('abc', 'utf8'),
        Buffer.from('abd', 'utf8'),
      ),
    ).toBe(false);
  });

  it('compares the hex text of two signatures, not their decoded bytes', () => {
    const providedHex = Buffer.from('ab'.repeat(32), 'utf8');
    const expectedHex = Buffer.from('cd'.repeat(32), 'utf8');
    expect(constantTimeEquals(providedHex, expectedHex)).toBe(false);
    expect(
      constantTimeEquals(providedHex, Buffer.from('ab'.repeat(32), 'utf8')),
    ).toBe(true);
  });

  it('fails closed instead of throwing when given input timingSafeEqual rejects', () => {
    const notABuffer = 'plain string' as unknown as Buffer;
    expect(() =>
      constantTimeEquals(notABuffer, Buffer.from('plain string', 'utf8')),
    ).not.toThrow();
    expect(
      constantTimeEquals(notABuffer, Buffer.from('plain string', 'utf8')),
    ).toBe(false);
  });
});
