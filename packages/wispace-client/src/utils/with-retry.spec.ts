import { withRetry, isAbortError, isWispaceRetryable } from './with-retry';

describe('wispace-client/with-retry', () => {
  describe('isAbortError', () => {
    it('returns true for error with name=AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
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

  describe('isWispaceRetryable', () => {
    it('returns false for AbortError', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isWispaceRetryable(err)).toBe(false);
    });

    it('returns false for 4xx errors with isRetryable=false', () => {
      const err = { isRetryable: () => false };
      expect(isWispaceRetryable(err)).toBe(false);
    });

    it('returns true for 5xx errors with isRetryable=true', () => {
      const err = { isRetryable: () => true };
      expect(isWispaceRetryable(err)).toBe(true);
    });

    it('returns true for TypeError (network error)', () => {
      expect(isWispaceRetryable(new TypeError('fetch failed'))).toBe(true);
    });
  });

  describe('withRetry', () => {
    it('returns result on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient error and succeeds', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValue('ok');

      const promise = withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 100,
        shouldRetry: isWispaceRetryable,
      });

      await jest.runAllTimersAsync();
      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('throws immediately without retry when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('Caller aborted'));
      const fn = jest.fn().mockRejectedValue(new Error('should not reach'));

      await expect(
        withRetry(fn, {
          maxRetries: 3,
          baseDelayMs: 100,
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(0);
    });

    it('stops retrying after fn throws AbortError', async () => {
      const abortErr = Object.assign(new Error('aborted'), {
        name: 'AbortError',
      });
      const fn = jest.fn().mockRejectedValue(abortErr);

      await expect(
        withRetry(fn, {
          maxRetries: 3,
          baseDelayMs: 10,
          shouldRetry: () => true,
        }),
      ).rejects.toThrow(abortErr);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('stops retrying when signal is aborted between attempts', async () => {
      const controller = new AbortController();
      let callCount = 0;
      const fn = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          controller.abort();
          throw new TypeError('fetch failed');
        }
        return 'ok';
      });

      await expect(
        withRetry(fn, {
          maxRetries: 3,
          baseDelayMs: 0,
          shouldRetry: isWispaceRetryable,
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws last error for non-abort retryable errors', async () => {
      const err = new TypeError('network fail');
      const fn = jest.fn().mockRejectedValue(err);

      await expect(
        withRetry(fn, {
          maxRetries: 2,
          baseDelayMs: 1,
          shouldRetry: isWispaceRetryable,
        }),
      ).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });
});
