import { withTimeout } from './promise-timeout.utils';

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the promise value when it settles in time', async () => {
    const result = withTimeout(Promise.resolve('ok'), 1_000, 'LLM request');
    expect(await result).toBe('ok');
  });

  it('rejects with the label message when the promise is too slow', async () => {
    const slow = new Promise<string>(() => {});
    const result = withTimeout(slow, 100, 'Tool get_data');

    const assertion = expect(result).rejects.toThrow(
      'Tool get_data timed out after 100ms',
    );
    jest.advanceTimersByTime(100);
    await assertion;
  });

  it('propagates the original rejection', async () => {
    const result = withTimeout(
      Promise.reject(new Error('boom')),
      1_000,
      'LLM request',
    );
    await expect(result).rejects.toThrow('boom');
  });
});
