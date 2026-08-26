import { readBoundedJson } from './read-bounded-json';

describe('readBoundedJson', () => {
  it('parses a valid JSON response', async () => {
    const response = new Response(JSON.stringify({ id: 1, name: 'test' }));
    const result = await readBoundedJson<{ id: number; name: string }>(
      response,
    );
    expect(result).toEqual({ id: 1, name: 'test' });
  });

  it('throws on oversized response body', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(200) });
    const response = new Response(payload);

    await expect(readBoundedJson(response, 64)).rejects.toThrow();
  });

  it('throws on malformed JSON', async () => {
    const response = new Response('{invalid json');

    await expect(readBoundedJson(response)).rejects.toThrow(SyntaxError);
  });

  it('respects custom maxBytes', async () => {
    const payload = JSON.stringify({ data: 'hello' });
    const response = new Response(payload);

    const result = await readBoundedJson<{ data: string }>(response, 1024);
    expect(result).toEqual({ data: 'hello' });
  });
});
