import { isAbortError, sleep } from './abort.utils';

describe('bot-common/abort.utils', () => {
  describe('isAbortError', () => {
    it('returns true for an AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isAbortError(err)).toBe(true);
    });

    it('returns true for a TimeoutError (undici/opossum deadline)', () => {
      const err = new Error('operation timed out');
      err.name = 'TimeoutError';
      expect(isAbortError(err)).toBe(true);
    });

    it('returns false for a regular Error', () => {
      expect(isAbortError(new Error('oops'))).toBe(false);
    });

    it('returns false for non-object values', () => {
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError('abort')).toBe(false);
    });
  });

  describe('sleep', () => {
    it('resolves after the given delay', async () => {
      const start = Date.now();
      await sleep(10);
      expect(Date.now() - start).toBeGreaterThanOrEqual(9);
    });

    it('rejects immediately when the signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('caller aborted'));

      await expect(sleep(100, controller.signal)).rejects.toThrow(
        'caller aborted',
      );
    });

    it('rejects when the signal fires during the sleep', async () => {
      const controller = new AbortController();
      const promise = sleep(100, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow();
    });
  });
});
