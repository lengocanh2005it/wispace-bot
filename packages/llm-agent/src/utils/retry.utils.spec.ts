import { retryWithBackoff } from './retry.utils';

describe('retry.utils', () => {
  describe('retryWithBackoff', () => {
    it('returns result on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetryable: () => true,
      });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable errors with exponential backoff', async () => {
      jest.useFakeTimers();
      const error = new Error('transient');
      const fn = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        isRetryable: () => true,
      });

      await jest.advanceTimersByTimeAsync(100); // attempt 1: 100 * 2^0 = 100ms
      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('exhausts all attempts and throws last error', async () => {
      const error = new Error('fail');
      const fn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 1,
          isRetryable: () => true,
        }),
      ).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('stops retrying on non-retryable errors', async () => {
      const error = new Error('permanent');
      const fn = jest.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          isRetryable: () => false,
        }),
      ).rejects.toThrow('permanent');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('calls onRetry with attempt and delay', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValue('ok');
      const onRetry = jest.fn();

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        isRetryable: () => true,
        onRetry,
        rng: () => 1, // pin equal-jitter to its ceiling: delay == nominal
      });

      await jest.advanceTimersByTimeAsync(100);
      await promise;
      expect(onRetry).toHaveBeenCalledWith(1, 100, expect.any(Error));
      jest.useRealTimers();
    });

    it('applies equal jitter to the backoff delay', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValue('ok');
      const onRetry = jest.fn();

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        isRetryable: () => true,
        onRetry,
        rng: () => 0, // floor: delay == nominal / 2
      });

      await jest.advanceTimersByTimeAsync(50);
      await promise;
      expect(onRetry).toHaveBeenCalledWith(1, 50, expect.any(Error));
      jest.useRealTimers();
    });

    it('caps the pre-jitter backoff at maxDelayMs', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('err'))
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValue('ok');
      const onRetry = jest.fn();

      const promise = retryWithBackoff(fn, {
        maxAttempts: 4,
        baseDelayMs: 1000, // attempt 2 nominal would be 2000ms without the cap
        maxDelayMs: 1500,
        isRetryable: () => true,
        onRetry,
        rng: () => 1,
      });

      await jest.advanceTimersByTimeAsync(1000); // attempt 1: min(1000, 1500) = 1000
      await jest.advanceTimersByTimeAsync(1500); // attempt 2: min(2000, 1500) = 1500
      await promise;
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, 1000, expect.any(Error));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, 1500, expect.any(Error));
      jest.useRealTimers();
    });

    it('uses custom backoff function when provided', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValue('ok');
      const backoff = jest.fn().mockReturnValue(50);

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 100,
        isRetryable: () => true,
        backoff,
      });

      await jest.advanceTimersByTimeAsync(50);
      await promise;
      expect(backoff).toHaveBeenCalledWith(1);
      jest.useRealTimers();
    });

    it('stops retrying immediately when signal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = jest.fn().mockRejectedValue(new Error('err'));

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 100,
          isRetryable: () => true,
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(0);
    });

    it('stops retrying when fn throws an AbortError', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const fn = jest.fn().mockRejectedValue(abortError);

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          isRetryable: () => true,
        }),
      ).rejects.toThrow(abortError);

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
