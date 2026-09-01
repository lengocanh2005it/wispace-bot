import { jitteredDelayMs } from './jitter.utils';

describe('bot-common/jitter.utils', () => {
  describe('jitteredDelayMs', () => {
    it('returns the nominal delay when rng is at its ceiling', () => {
      expect(jitteredDelayMs(1000, () => 1)).toBe(1000);
    });

    it('returns half the nominal delay when rng is at its floor', () => {
      expect(jitteredDelayMs(1000, () => 0)).toBe(500);
    });

    it('scales linearly with the rng sample', () => {
      expect(jitteredDelayMs(1000, () => 0.5)).toBe(750);
    });

    it('keeps every sample within [nominal/2, nominal)', () => {
      let seed = 0;
      const rng = () => {
        seed += 0.017;
        return seed % 1;
      };
      for (let i = 0; i < 500; i++) {
        const d = jitteredDelayMs(2000, rng);
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThan(2000);
      }
    });

    it('produces different delays for different rng samples (no herd)', () => {
      const samples = [0.1, 0.4, 0.9, 0.25].map((v) =>
        jitteredDelayMs(1000, () => v),
      );
      expect(new Set(samples).size).toBe(samples.length);
    });

    it('defaults to Math.random when no rng is passed', () => {
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(jitteredDelayMs(1000)).toBe(750);
      spy.mockRestore();
    });

    it('returns 0 for a 0 nominal delay', () => {
      expect(jitteredDelayMs(0, () => 0.7)).toBe(0);
    });
  });
});
