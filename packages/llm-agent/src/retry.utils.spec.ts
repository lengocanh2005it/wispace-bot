import { cappedExponentialBackoff, retryWithBackoff } from './retry.utils';

describe('retry.utils', () => {
  describe('cappedExponentialBackoff', () => {
    const backoff = cappedExponentialBackoff(1000, 8000);

    it('doubles each attempt below the cap', () => {
      expect(backoff(1)).toBe(1000);
      expect(backoff(2)).toBe(2000);
      expect(backoff(3)).toBe(4000);
    });

    it('clamps at maxDelayMs once the exponential passes it', () => {
      expect(backoff(4)).toBe(8000); // 1000 * 2^3 = 8000
      expect(backoff(5)).toBe(8000); // 16000 clamped
      expect(backoff(9)).toBe(8000);
    });
  });

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

    it('grows the backoff each attempt (pinned rng) and never exceeds nominal', async () => {
      jest.useFakeTimers();
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('err'))
        .mockRejectedValueOnce(new Error('err'))
        .mockResolvedValue('ok');
      const onRetry = jest.fn();

      const promise = retryWithBackoff(fn, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        isRetryable: () => true,
        onRetry,
        rng: () => 1, // ceiling: delay == nominal
      });

      await jest.advanceTimersByTimeAsync(1000); // attempt 1: 1000 * 2^0
      await jest.advanceTimersByTimeAsync(2000); // attempt 2: 1000 * 2^1
      await promise;
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, 1000, expect.any(Error));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, 2000, expect.any(Error));
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

    it('retries a per-attempt TimeoutError when the classifier allows it', async () => {
      jest.useFakeTimers();
      const timeoutControllers: AbortController[] = [];
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() => {
          const controller = new AbortController();
          timeoutControllers.push(controller);
          return controller.signal;
        });
      let calls = 0;
      const timeoutError = new DOMException('Timed out', 'TimeoutError');
      const fn = jest.fn((signal?: AbortSignal) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(timeoutError), {
              once: true,
            });
            timeoutControllers.at(-1)?.abort(timeoutError);
          });
        }
        return Promise.resolve('ok');
      });
      const isRetryable = jest.fn().mockReturnValue(true);

      try {
        const promise = retryWithBackoff(fn, {
          maxAttempts: 2,
          baseDelayMs: 0,
          isRetryable,
          perAttemptTimeoutMs: 20,
          rng: () => 1,
        });

        await jest.runAllTimersAsync();
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(isRetryable).toHaveBeenCalledWith(timeoutError);
      } finally {
        timeoutSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('retries a wrapped attempt timeout based on signal state', async () => {
      jest.useFakeTimers();
      const timeoutControllers: AbortController[] = [];
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() => {
          const controller = new AbortController();
          timeoutControllers.push(controller);
          return controller.signal;
        });
      let calls = 0;
      const wrappedTimeout = Object.assign(new Error('wrapped timeout'), {
        name: 'AbortError',
      });
      const fn = jest.fn((signal?: AbortSignal) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(wrappedTimeout), {
              once: true,
            });
            timeoutControllers.at(-1)?.abort(wrappedTimeout);
          });
        }
        return Promise.resolve('ok');
      });
      const isRetryable = jest.fn().mockReturnValue(true);

      try {
        const promise = retryWithBackoff(fn, {
          maxAttempts: 2,
          baseDelayMs: 0,
          isRetryable,
          perAttemptTimeoutMs: 20,
          rng: () => 1,
        });

        await jest.runAllTimersAsync();
        await expect(promise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(isRetryable).toHaveBeenCalledWith(wrappedTimeout);
      } finally {
        timeoutSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('per-attempt timeout: fn receives an AbortSignal when perAttemptTimeoutMs is set', async () => {
      const fn = jest.fn().mockResolvedValue('ok');

      await retryWithBackoff(fn, {
        maxAttempts: 1,
        baseDelayMs: 10,
        isRetryable: () => true,
        perAttemptTimeoutMs: 10_000,
      });

      // fn should receive an AbortSignal (the composed per-attempt signal)
      const receivedSignal = fn.mock.calls[0][0];
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal.aborted).toBe(false);
    });

    it('per-attempt timeout: fn receives undefined signal when perAttemptTimeoutMs is not set', async () => {
      const fn = jest.fn().mockResolvedValue('ok');

      await retryWithBackoff(fn, {
        maxAttempts: 1,
        baseDelayMs: 10,
        isRetryable: () => true,
      });

      const receivedSignal = fn.mock.calls[0][0];
      expect(receivedSignal).toBeUndefined();
    });

    it('per-attempt timeout: aborts hung attempt after timeout (real timers)', async () => {
      const fn = jest.fn().mockImplementation(
        (signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            );
          }),
      );

      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 1,
          baseDelayMs: 10,
          isRetryable: () => true,
          perAttemptTimeoutMs: 50,
        }),
      ).rejects.toThrow('aborted');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('per-attempt timeout: global signal abort overrides per-attempt', async () => {
      const controller = new AbortController();
      const fn = jest.fn().mockImplementation(
        (signal?: AbortSignal) =>
          new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            );
          }),
      );

      const promise = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetryable: () => true,
        perAttemptTimeoutMs: 60_000, // generous per-attempt
        signal: controller.signal,
      });

      controller.abort();

      await expect(promise).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
