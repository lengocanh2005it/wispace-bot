/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { UserGoalsApiClient } from './user-goals-api.client';
import { WispaceApiError } from '../errors/wispace-api.error';
import { ShapeValidationError } from '../utils/validate-shape';

describe('UserGoalsApiClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches goals with the given id header', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ targetScore: '7', examDate: '2026-08-01' }),
    });
    global.fetch = fetchMock;

    const client = new UserGoalsApiClient({
      url: 'https://backend.example.com/api/User/goals',
      internalKey: 'internal-key',
    });

    const result = await client.getUserGoals('x-discordid', 'discord-1');

    expect(result).toEqual({ targetScore: '7', examDate: '2026-08-01' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example.com/api/User/goals',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-discordid': 'discord-1' }),
      }),
    );
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('down'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ targetScore: '7', examDate: '2026-08-01' }),
      });
    global.fetch = fetchMock;

    const client = new UserGoalsApiClient({
      url: 'https://backend.example.com/api/User/goals',
      internalKey: 'internal-key',
      baseDelayMs: 1,
    });

    const result = await client.getUserGoals('x-psid', 'psid-1');

    expect(result.targetScore).toBe('7');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws WispaceApiError without retry on 4xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('missing'),
    });
    global.fetch = fetchMock;

    const client = new UserGoalsApiClient({
      url: 'https://backend.example.com/api/User/goals',
      internalKey: 'internal-key',
      baseDelayMs: 1,
    });

    await expect(
      client.getUserGoals('x-psid', 'psid-1'),
    ).rejects.toBeInstanceOf(WispaceApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when the caller signal is already aborted', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    global.fetch = fetchMock;

    const client = new UserGoalsApiClient({
      url: 'https://backend.example.com/api/User/goals',
      internalKey: 'internal-key',
    });

    const controller = new AbortController();
    controller.abort(new Error('caller gone'));

    await expect(
      client.getUserGoals('x-psid', 'psid-1', { signal: controller.signal }),
    ).rejects.toThrow('caller gone');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the in-flight fetch on per-attempt timeout and does not retry', async () => {
    const fetchMock = jest.fn().mockImplementation(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(
              init.signal?.reason instanceof Error
                ? init.signal.reason
                : new Error('aborted'),
            ),
          );
        }),
    );
    global.fetch = fetchMock;

    const client = new UserGoalsApiClient({
      url: 'https://backend.example.com/api/User/goals',
      internalKey: 'internal-key',
      requestTimeoutMs: 30,
      baseDelayMs: 1,
    });

    await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('contract validation', () => {
    it('accepts valid response shape', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ targetScore: '7.0', examDate: '2026-09-01' }),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
      });

      const result = await client.getUserGoals('x-psid', 'psid-1');
      expect(result.targetScore).toBe('7.0');
      expect(result.examDate).toBe('2026-09-01');
    });

    it('throws ShapeValidationError for malformed response (missing field)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ examDate: '2026-09-01' }),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
      });

      await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow(
        ShapeValidationError,
      );
    });

    it('throws ShapeValidationError for malformed response (wrong type)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ targetScore: 123, examDate: '2026-09-01' }),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
      });

      await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow(
        ShapeValidationError,
      );
    });

    it('throws ShapeValidationError for non-object response', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve('not-an-object'),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
      });

      await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow(
        ShapeValidationError,
      );
    });

    it('does not retry on contract validation failure', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: true }),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
        baseDelayMs: 1,
      });

      await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow(
        ShapeValidationError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('response size limits', () => {
    it('rejects response body exceeding 16KB default', async () => {
      const oversized = {
        targetScore: 'x'.repeat(20 * 1024),
        examDate: '2026-09-01',
      };
      const text = JSON.stringify(oversized);
      const bytes = new TextEncoder().encode(text);
      let read = false;
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockImplementation(() => {
              if (read)
                return Promise.resolve({ done: true, value: undefined });
              read = true;
              return Promise.resolve({ done: false, value: bytes });
            }),
            cancel: jest.fn(),
            releaseLock: jest.fn(),
          }),
        },
        json: () => Promise.resolve(oversized),
      });
      global.fetch = fetchMock;

      const client = new UserGoalsApiClient({
        url: 'https://backend.example.com/api/User/goals',
        internalKey: 'internal-key',
      });

      await expect(client.getUserGoals('x-psid', 'psid-1')).rejects.toThrow();
    });
  });
});
