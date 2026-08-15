import { MessengerOutboundService } from './messenger-outbound.service';

const OK_RESPONSE = {
  ok: true,
  status: 200,
  statusText: 'OK',
  text: () => Promise.resolve(''),
} as unknown as Response;

function buildService(timeoutMs: string): MessengerOutboundService {
  const configService = {
    get: (key: string) =>
      key === 'MESSENGER_SEND_API_TIMEOUT_MS'
        ? timeoutMs
        : key === 'PAGE_ACCESS_TOKEN'
          ? 'page-token'
          : undefined,
  };
  const repository = {
    createLog: jest.fn(),
  };
  return new MessengerOutboundService(
    configService as never,
    repository as never,
  );
}

describe('MessengerOutboundService breaker/fetch timeout alignment (#133)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the configured send-API timeout as the breaker budget', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(OK_RESPONSE);
    const service = buildService('2000');

    await service.sendSenderAction('psid-1', 'mark_seen');

    expect(globalFetch).toHaveBeenCalledTimes(1);
    // keepAliveFetch converts timeoutMs into AbortSignal.timeout(signal) —
    // the fetch and the breaker share the same budget.
    const init = globalFetch.mock.calls[0]?.[1] as RequestInit & {
      signal?: AbortSignal;
    };
    expect(init.signal?.aborted).toBe(false);
  });

  it('succeeds when the Send API responds below the breaker budget', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(OK_RESPONSE), 50)),
      );
    const service = buildService('2000');

    await expect(
      service.sendSenderAction('psid-1', 'mark_seen'),
    ).resolves.toBeUndefined();
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('fails at the breaker budget and never records a late delivery', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(OK_RESPONSE), 500)),
      );
    const service = buildService('200');

    const startedAt = Date.now();
    await expect(
      service.sendSenderAction('psid-1', 'mark_seen'),
    ).rejects.toThrow();

    // The caller failed at the shared budget (~200ms), not after the 500ms
    // fetch — no window where the breaker reports failure while the fetch
    // keeps running and could deliver late.
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});
