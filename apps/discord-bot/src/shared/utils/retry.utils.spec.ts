import { retryWithBackoff } from './retry.utils';

describe('retryWithBackoff', () => {
  it('resolves on the first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with linear backoff then succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue('ok');
    const timer = jest.spyOn(global, 'setTimeout');

    await expect(retryWithBackoff(fn, 3, 10)).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 10);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 20);
    timer.mockRestore();
  });

  it('throws the last error after exhausting all attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('db down'));

    await expect(retryWithBackoff(fn, 3, 1)).rejects.toThrow('db down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
