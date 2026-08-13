/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { PrecreateExerciseApiClient } from './precreate-exercise-api.client';
import { WispaceApiError } from '../errors/wispace-api.error';

const URL = 'https://backend.example.com/api/roadmap/precreate-exercise';

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PrecreateExerciseApiClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each([
    ['x-psid', 'messenger-1'],
    ['x-discordid', 'discord-1'],
    ['x-zaloid', 'zalo-1'],
  ] as const)('posts without a body using %s', async (idHeader, externalId) => {
    const fetchMock = jest.fn().mockResolvedValue(
      response({
        hasRoadmap: true,
        finishedAllExercises: false,
        alreadyExists: false,
        exerciseUrl: ' https://frontend.example.com/exercise/8 ',
        message: 'generated',
      }),
    );
    global.fetch = fetchMock;

    const client = new PrecreateExerciseApiClient({
      url: URL,
      internalKey: 'internal-key',
      maxRetries: 0,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.precreateNextExercise(idHeader, externalId),
    ).resolves.toEqual({
      status: 'created',
      exerciseUrl: 'https://frontend.example.com/exercise/8',
      message: 'generated',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: 'POST',
        headers: {
          [idHeader]: externalId,
          'X-Internal-Key': 'internal-key',
          Accept: 'application/json',
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.not.objectContaining({ body: expect.anything() }),
    );
  });

  it.each([
    [
      { hasRoadmap: false, finishedAllExercises: true, alreadyExists: true },
      'no_roadmap',
    ],
    [
      { hasRoadmap: true, finishedAllExercises: true, alreadyExists: true },
      'finished_all',
    ],
    [
      {
        hasRoadmap: true,
        finishedAllExercises: false,
        alreadyExists: true,
        exerciseUrl: 'https://frontend.example.com/exercise/8',
      },
      'already_exists',
    ],
    [
      {
        hasRoadmap: true,
        finishedAllExercises: false,
        alreadyExists: false,
        exerciseUrl: 'https://frontend.example.com/exercise/8',
      },
      'created',
    ],
  ] as const)('maps status precedence to %s', async (payload, status) => {
    global.fetch = jest.fn().mockResolvedValue(response(payload));
    const client = new PrecreateExerciseApiClient({
      url: URL,
      internalKey: 'internal-key',
      maxRetries: 0,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.precreateNextExercise('x-psid', 'psid-1'),
    ).resolves.toMatchObject({
      status,
    });
  });

  it.each([
    { hasRoadmap: true, finishedAllExercises: false, alreadyExists: false },
    {
      hasRoadmap: true,
      finishedAllExercises: false,
      alreadyExists: false,
      exerciseUrl: 'http://frontend.example.com/exercise/8',
    },
    {
      hasRoadmap: true,
      finishedAllExercises: false,
      alreadyExists: true,
      exerciseUrl: 'javascript:alert(1)',
    },
  ])('rejects an invalid response requiring a URL', async (payload) => {
    global.fetch = jest.fn().mockResolvedValue(response(payload));
    const client = new PrecreateExerciseApiClient({
      url: URL,
      internalKey: 'internal-key',
      maxRetries: 0,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.precreateNextExercise('x-psid', 'psid-1'),
    ).rejects.toThrow();
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 }), 1],
    ['4xx', new Response('bad', { status: 400, statusText: 'Bad Request' }), 1],
    [
      '5xx',
      new Response('down', { status: 503, statusText: 'Unavailable' }),
      1,
    ],
    [
      '429',
      new Response('busy', { status: 429, statusText: 'Too Many Requests' }),
      1,
    ],
  ])('does not retry on %s', async (_label, fetchResponse, calls) => {
    global.fetch = jest.fn().mockResolvedValue(fetchResponse);
    const client = new PrecreateExerciseApiClient({
      url: URL,
      internalKey: 'internal-key',
      maxRetries: 0,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.precreateNextExercise('x-psid', 'psid-1'),
    ).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(calls);
  });

  it('throws a WispaceApiError for HTTP failures', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('secret backend body', {
        status: 500,
        statusText: 'Unavailable',
      }),
    );
    const client = new PrecreateExerciseApiClient({
      url: URL,
      internalKey: 'internal-key',
      maxRetries: 0,
      requestTimeoutMs: 30_000,
    });

    await expect(
      client.precreateNextExercise('x-psid', 'psid-1'),
    ).rejects.toBeInstanceOf(WispaceApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'timeout'] as const)(
    'does not retry on %s failure',
    async (kind) => {
      global.fetch = jest.fn().mockImplementation(
        (_url: unknown, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            if (kind === 'network') {
              reject(new Error('network down'));
              return;
            }
            init.signal?.addEventListener('abort', () =>
              reject(new Error('timed out')),
            );
          }),
      );
      const client = new PrecreateExerciseApiClient({
        url: URL,
        internalKey: 'internal-key',
        maxRetries: 0,
        requestTimeoutMs: 1,
      });

      await expect(
        client.precreateNextExercise('x-psid', 'psid-1'),
      ).rejects.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );
});
