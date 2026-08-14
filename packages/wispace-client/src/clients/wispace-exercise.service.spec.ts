import { WispaceExerciseService } from './wispace-exercise.service';

describe('WispaceExerciseService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('accepts a framework-agnostic client config and sends the configured request', async () => {
    const response = new Response(
      JSON.stringify({
        hasRoadmap: true,
        finishedAllExercises: false,
        alreadyExists: false,
        exerciseUrl: 'https://frontend.example.com/exercise/8',
      }),
      { status: 200 },
    );
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void input;
        void init;
        return Promise.resolve(response);
      },
    );
    global.fetch = fetchMock;

    const service = new WispaceExerciseService('x-zaloid', {
      url: 'https://backend.example.com/precreate',
      internalKey: 'internal-key',
      requestTimeoutMs: 30_000,
    });

    await expect(
      service.precreateNextExercise('zalo-1'),
    ).resolves.toMatchObject({
      status: 'created',
      exerciseUrl: 'https://frontend.example.com/exercise/8',
    });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://backend.example.com/precreate');
    const request = call?.[1];
    expect(new Headers(request?.headers).get('x-zaloid')).toBe('zalo-1');
  });
});
