import { withTimeout } from './promise-timeout.utils';

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with the promise value when it settles in time', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 1_000, 'LLM request'),
    ).resolves.toBe('ok');
  });

  it('rejects with the labelled timeout and invokes the timeout hook', async () => {
    const onTimeout = jest.fn();
    const result = withTimeout(
      new Promise<string>(() => {}),
      100,
      'Tool get_data',
      onTimeout,
    );
    const assertion = expect(result).rejects.toThrow(
      'Tool get_data timed out after 100ms',
    );

    jest.advanceTimersByTime(100);
    await assertion;

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not cancel the underlying promise when no timeout hook is given', async () => {
    let resolveOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
    const result = withTimeout(operation, 100, 'Messenger tool');
    const assertion = expect(result).rejects.toThrow(
      'Messenger tool timed out after 100ms',
    );

    jest.advanceTimersByTime(100);
    await assertion;
    resolveOperation('operation continued');

    await expect(operation).resolves.toBe('operation continued');
  });

  it('normalizes non-Error promise rejections', async () => {
    await expect(
      withTimeout(Promise.reject('boom'), 1_000, 'LLM request'),
    ).rejects.toThrow('boom');
  });
});
