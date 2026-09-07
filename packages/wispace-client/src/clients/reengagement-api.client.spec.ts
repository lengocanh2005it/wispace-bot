/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { ReengagementApiClient } from './reengagement-api.client';

const BASE_URL = 'https://backend.example.com/api/bot/reengagement';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(
  overrides: Partial<
    ConstructorParameters<typeof ReengagementApiClient>[0]
  > = {},
): ReengagementApiClient {
  return new ReengagementApiClient({
    url: BASE_URL,
    internalKey: 'internal-key',
    maxRetries: 0,
    ...overrides,
  });
}

describe('ReengagementApiClient.getCandidates', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('GETs the candidates endpoint with the internal key and defaults', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        totalCandidates: 1,
        candidates: [
          {
            userId: 'wispace-1',
            discordId: 'discord-1',
            psid: null,
            email: 'learner@example.com',
            userName: 'Lan',
            platform: 'discord',
            lastActiveAt: '2026-08-20T10:00:00.000Z',
            daysInactive: 12,
            variant: 'a',
          },
        ],
      }),
    );
    global.fetch = fetchMock;

    const client = makeClient();
    const result = await client.getCandidates({ limit: 50 });

    expect(result.totalCandidates).toBe(1);
    expect(result.candidates).toEqual([
      {
        userId: 'wispace-1',
        discordId: 'discord-1',
        psid: null,
        email: 'learner@example.com',
        userName: 'Lan',
        platform: 'discord',
        lastActiveAt: '2026-08-20T10:00:00.000Z',
        daysInactive: 12,
        variant: 'a',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/candidates?platform=discord&days=11&limit=50`,
      expect.objectContaining({
        method: 'GET',
        headers: {
          'X-Internal-Key': 'internal-key',
          Accept: 'application/json',
        },
      }),
    );
  });

  it('coalesces omitted nullable fields to null, not undefined', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        totalCandidates: 1,
        candidates: [
          {
            userId: 'wispace-2',
            userName: 'Minh',
            platform: 'discord',
            lastActiveAt: '2026-08-21T10:00:00.000Z',
            daysInactive: 11,
            variant: 'b',
          },
        ],
      }),
    );
    const client = makeClient();

    const result = await client.getCandidates({ limit: 10 });

    expect(result.candidates[0]).toEqual({
      userId: 'wispace-2',
      discordId: null,
      psid: null,
      email: null,
      userName: 'Minh',
      platform: 'discord',
      lastActiveAt: '2026-08-21T10:00:00.000Z',
      daysInactive: 11,
      variant: 'b',
    });
  });

  it.each([
    [0, 1],
    [-5, 1],
    [201, 200],
    [50.7, 50],
  ] as const)('clamps limit %s to %s', async (limit, expected) => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ totalCandidates: 0, candidates: [] }));
    const client = makeClient();

    await client.getCandidates({ limit });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe(
      `${BASE_URL}/candidates?platform=discord&days=11&limit=${expected}`,
    );
  });

  it('passes explicit platform and days overrides', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ totalCandidates: 0, candidates: [] }));
    const client = makeClient();

    await client.getCandidates({ platform: 'messenger', days: 7, limit: 10 });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe(
      `${BASE_URL}/candidates?platform=messenger&days=7&limit=10`,
    );
  });

  it('surfaces 401 as WispaceApiError with statusCode 401', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('unauthorized', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );
    const client = makeClient();

    await expect(client.getCandidates({ limit: 50 })).rejects.toMatchObject({
      name: 'WispaceApiError',
      statusCode: 401,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx then surfaces WispaceApiError', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('down', { status: 503, statusText: 'Unavailable' }),
      );
    const client = makeClient({ maxRetries: 2, baseDelayMs: 1 });

    await expect(client.getCandidates({ limit: 50 })).rejects.toMatchObject({
      name: 'WispaceApiError',
      statusCode: 503,
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects a malformed candidate body', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ totalCandidates: 1, candidates: [{ userId: '' }] }),
      );
    const client = makeClient();

    await expect(client.getCandidates({ limit: 50 })).rejects.toThrow(
      /variant|userId|userName|platform/,
    );
  });
});

describe('ReengagementApiClient.getPayload', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const validPayload = {
    variant: 'b',
    period: 'last-1-month',
    is_fallback: true,
    summary: { totalEssays: 1 },
    discord_payload: {
      embeds: [{ title: 'Report' }],
      components: [{ type: 1, components: [] }],
    },
  };

  it('GETs the payload endpoint with platform query and rejects an empty userId', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(validPayload));
    global.fetch = fetchMock;
    const client = makeClient();

    const result = await client.getPayload('wispace-1');

    expect(result).toEqual(validPayload);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/payload/wispace-1?platform=discord`,
      expect.objectContaining({ method: 'GET' }),
    );
    await expect(client.getPayload('   ')).rejects.toThrow(/userId/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('passes a platform override and encodes the userId path segment', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(validPayload));
    const client = makeClient();

    await client.getPayload('user/1 x', { platform: 'messenger' });

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe(`${BASE_URL}/payload/user%2F1%20x?platform=messenger`);
  });

  it.each([
    [
      '401',
      new Response('no', { status: 401, statusText: 'Unauthorized' }),
      401,
    ],
    [
      '5xx',
      new Response('down', { status: 500, statusText: 'Server Error' }),
      500,
    ],
  ] as const)('surfaces %s distinctly', async (_label, res, status) => {
    global.fetch = jest.fn().mockResolvedValue(res);
    const client = makeClient();

    await expect(client.getPayload('wispace-1')).rejects.toMatchObject({
      name: 'WispaceApiError',
      statusCode: status,
    });
  });

  it('rejects a malformed payload body (bad embeds / unknown variant)', async () => {
    const client = makeClient();

    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ ...validPayload, discord_payload: { embeds: 'no' } }),
      );
    await expect(client.getPayload('wispace-1')).rejects.toThrow(
      /discord_payload/,
    );

    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ ...validPayload, variant: 'c' }));
    await expect(client.getPayload('wispace-1')).rejects.toThrow();
  });
});

describe('ReengagementApiClient.markSent', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs a snake_case body without retrying on failure', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, logId: 'log-1' }));
    global.fetch = fetchMock;
    const client = makeClient();

    await expect(
      client.markSent({
        userId: 'wispace-1',
        platform: 'discord',
        daysInactive: 12,
        variant: 'b',
        status: 'SUCCESS',
        messageId: 'm-1',
      }),
    ).resolves.toEqual({ success: true, logId: 'log-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/mark-sent`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-Internal-Key': 'internal-key',
          Accept: 'application/json',
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      user_id: 'wispace-1',
      platform: 'discord',
      days_inactive: 12,
      variant: 'b',
      status: 'SUCCESS',
      message_id: 'm-1',
    });
  });

  it('omits message_id when absent', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, logId: null }));
    global.fetch = fetchMock;
    const client = makeClient();

    await expect(
      client.markSent({
        userId: 'wispace-1',
        platform: 'discord',
        daysInactive: 11,
        variant: 'a',
        status: 'FAILED',
      }),
    ).resolves.toEqual({ success: true, logId: null });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('message_id');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['401', 401],
    ['5xx', 503],
  ] as const)('fails fast on %s (no retry)', async (_label, status) => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('no', { status, statusText: 'Err' }));
    const client = makeClient({ maxRetries: 3, baseDelayMs: 1 });

    await expect(
      client.markSent({
        userId: 'wispace-1',
        platform: 'discord',
        daysInactive: 11,
        variant: 'a',
        status: 'FAILED',
      }),
    ).rejects.toMatchObject({ name: 'WispaceApiError', statusCode: status });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed mark-sent body', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = makeClient();

    await expect(
      client.markSent({
        userId: 'wispace-1',
        platform: 'discord',
        daysInactive: 11,
        variant: 'a',
        status: 'SUCCESS',
      }),
    ).rejects.toThrow();
  });
});
