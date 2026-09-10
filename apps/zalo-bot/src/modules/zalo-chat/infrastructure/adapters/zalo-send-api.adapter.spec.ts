import { ZaloSendApiAdapter } from './zalo-send-api.adapter';

describe('ZaloSendApiAdapter', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('sends the provider request and returns a transport DTO', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ error: 0, message: 'Success' }),
      text: () => Promise.resolve('{"error":0,"message":"Success"}'),
    });
    global.fetch = fetchMock;
    const adapter = new ZaloSendApiAdapter();

    await expect(
      adapter.sendText({
        recipientId: 'zalo-1',
        text: 'hello',
        accessToken: 'token-abc',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        status: 200,
        applicationError: 0,
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).access_token).toBe(
      'token-abc',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      recipient: { user_id: 'zalo-1' },
      message: { text: 'hello' },
    });
    expect(init).toEqual(
      expect.objectContaining({ dispatcher: expect.anything() }),
    );
  });

  it('preserves HTTP and application errors without exposing Response objects', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve('{"error":4001,"message":"Invalid user id"}'),
    });
    const adapter = new ZaloSendApiAdapter();

    await expect(
      adapter.sendText({
        recipientId: 'zalo-1',
        text: 'hello',
        accessToken: 'token-abc',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        status: 200,
        applicationError: 4001,
      }),
    );
  });
});
