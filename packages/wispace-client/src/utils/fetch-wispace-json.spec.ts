import { fetchWispaceJson, ARRAY_MAX_BYTES } from './fetch-wispace-json';

function mockResponse(body: string, opts?: { status?: number }): Response {
  const bytes = new TextEncoder().encode(body);
  let read = false;
  return {
    ok: true,
    status: opts?.status ?? 200,
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (read) return Promise.resolve({ done: true, value: undefined });
          read = true;
          return Promise.resolve({ done: false, value: bytes });
        }),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      }),
    },
    text: jest.fn(),
    json: jest.fn(),
  } as unknown as Response;
}

describe('fetchWispaceJson', () => {
  it('parses a normal JSON response within default 16KB limit', async () => {
    const data = { targetScore: '6.5', examDate: '2026-09-01' };
    const res = mockResponse(JSON.stringify(data));

    const result = await fetchWispaceJson(res);

    expect(result).toEqual(data);
  });

  it('parses an array response with custom maxBytes', async () => {
    const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const res = mockResponse(JSON.stringify(data));

    const result = await fetchWispaceJson(res, { maxBytes: ARRAY_MAX_BYTES });

    expect(result).toEqual(data);
    expect(Array.isArray(result)).toBe(true);
  });

  it('throws on oversized response body', async () => {
    const oversized = 'x'.repeat(20 * 1024); // 20KB > 16KB default
    const res = mockResponse(`"${oversized}"`);

    await expect(fetchWispaceJson(res)).rejects.toThrow();
  });

  it('allows oversized response when maxBytes is raised', async () => {
    const large = 'x'.repeat(20 * 1024);
    const res = mockResponse(`"${large}"`);

    const result = await fetchWispaceJson(res, { maxBytes: 32 * 1024 });

    expect(result).toBe(large);
  });

  it('throws on malformed JSON', async () => {
    const res = mockResponse('{ invalid json {{{');

    await expect(fetchWispaceJson(res)).rejects.toThrow(/not valid JSON/);
  });

  it('falls back to response.text() when body is null', async () => {
    const data = { ok: true };
    const res = {
      ok: true,
      status: 200,
      body: null,
      json: jest.fn().mockResolvedValue(data),
      text: jest.fn().mockResolvedValue(JSON.stringify(data)),
    } as unknown as Response;

    const result = await fetchWispaceJson(res);

    expect(result).toEqual(data);
  });

  it('ARRAY_MAX_BYTES is 64KB', () => {
    expect(ARRAY_MAX_BYTES).toBe(64 * 1024);
  });
});
