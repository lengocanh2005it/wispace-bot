import { reportRetryAt } from './report-retry-at';

describe('reportRetryAt', () => {
  const NOW = 1_700_000_000_000;

  it('uses 15 minutes at the jitter ceiling (rng = 1)', () => {
    expect(reportRetryAt(15, () => 1, NOW).getTime()).toBe(NOW + 15 * 60_000);
  });

  it('uses 7.5 minutes at the jitter floor (rng = 0)', () => {
    expect(reportRetryAt(15, () => 0, NOW).getTime()).toBe(NOW + 7.5 * 60_000);
  });

  it('keeps every sample within [50%, 100%] of the nominal window', () => {
    let seed = 0;
    const rng = () => {
      seed += 0.019;
      return seed % 1;
    };
    for (let i = 0; i < 500; i++) {
      const delay = reportRetryAt(15, rng, NOW).getTime() - NOW;
      expect(delay).toBeGreaterThanOrEqual(7.5 * 60_000);
      expect(delay).toBeLessThan(15 * 60_000);
    }
  });

  it('produces different timestamps for different rng samples (no herd)', () => {
    const a = reportRetryAt(15, () => 0.2, NOW).getTime();
    const b = reportRetryAt(15, () => 0.8, NOW).getTime();
    expect(a).not.toBe(b);
  });

  it('defaults to Math.random and the current clock', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const before = Date.now();
    const at = reportRetryAt(15).getTime();
    const after = Date.now();
    expect(at).toBeGreaterThanOrEqual(before + 11.25 * 60_000);
    expect(at).toBeLessThanOrEqual(after + 11.25 * 60_000);
    spy.mockRestore();
  });
});
