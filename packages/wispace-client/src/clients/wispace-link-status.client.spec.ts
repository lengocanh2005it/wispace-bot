import { WispaceLinkStatusClient } from './wispace-link-status.client';

describe('WispaceLinkStatusClient', () => {
  const config = {
    url: 'https://wispace.example/link-status',
    internalKey: 'internal',
    header: 'x-psid' as const,
    enabled: true,
    maxRetries: 0,
  };

  afterEach(() => jest.restoreAllMocks());

  it('maps an authoritative active response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'active',
          userId: 42,
          ownershipVersion: 'v7',
        }),
        {
          status: 200,
        },
      ),
    );

    await expect(
      new WispaceLinkStatusClient(config).getStatus('psid-1'),
    ).resolves.toEqual({ kind: 'active', userId: 42, ownershipVersion: 'v7' });
  });

  it('treats 404 as confirmed revocation', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    await expect(
      new WispaceLinkStatusClient(config).getStatus('psid-1'),
    ).resolves.toEqual({ kind: 'revoked', reason: 'http_404' });
  });

  it('preserves the mapping on upstream outage', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(
      new WispaceLinkStatusClient(config).getStatus('psid-1'),
    ).resolves.toEqual({ kind: 'unknown', reason: 'upstream_unavailable' });
  });

  it('converts its own request timeout into a retryable unknown result', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal;
          requestSignal?.addEventListener('abort', () =>
            reject(requestSignal.reason),
          );
        }),
    );

    await expect(
      new WispaceLinkStatusClient({
        ...config,
        requestTimeoutMs: 1,
      }).getStatus('psid-1'),
    ).resolves.toEqual({ kind: 'unknown', reason: 'upstream_unavailable' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('never treats malformed 200 data as a revocation', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'active' }), { status: 200 }),
      );
    await expect(
      new WispaceLinkStatusClient(config).getStatus('psid-1'),
    ).resolves.toEqual({ kind: 'unknown', reason: 'invalid_response' });
  });
});
