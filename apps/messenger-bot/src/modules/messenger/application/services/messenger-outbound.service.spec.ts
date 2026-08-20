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

describe('MessengerOutboundService message logging privacy (#262)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs metadata only on sendTextViaPsid without persisting messageText', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(OK_RESPONSE);
    const logMessage = jest.fn().mockResolvedValue({});
    const repository = { logMessage };
    const configService = {
      get: (key: string) =>
        key === 'PAGE_ACCESS_TOKEN' ? 'page-token' : undefined,
    };
    const service = new MessengerOutboundService(
      configService as never,
      repository as never,
    );

    await service.sendTextViaPsid({
      psid: 'psid-test',
      text: 'Sensitive user text',
      messageType: 'FREE_FORM_CHAT_OUT',
      userId: 143,
    });

    expect(logMessage).toHaveBeenCalledWith({
      userId: 143,
      psid: 'psid-test',
      messageType: 'FREE_FORM_CHAT_OUT',
      status: 'SENT',
    });
    expect(
      (logMessage.mock.calls[0][0] as Record<string, unknown>).messageText,
    ).toBeUndefined();
  });

  it('logs metadata only on sendButtonTemplate without persisting messageText', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(OK_RESPONSE);
    const logMessage = jest.fn().mockResolvedValue({});
    const repository = { logMessage };
    const configService = {
      get: (key: string) =>
        key === 'PAGE_ACCESS_TOKEN' ? 'page-token' : undefined,
    };
    const service = new MessengerOutboundService(
      configService as never,
      repository as never,
    );

    await service.sendButtonTemplate({
      psid: 'psid-test',
      text: 'Button question',
      messageType: 'BUTTON_PROMPT',
      userId: 143,
      buttons: [{ type: 'postback', title: 'Option 1', payload: 'PAYLOAD_1' }],
    });

    expect(logMessage).toHaveBeenCalledWith({
      userId: 143,
      psid: 'psid-test',
      messageType: 'BUTTON_PROMPT',
      status: 'SENT',
    });
    expect(
      (logMessage.mock.calls[0][0] as Record<string, unknown>).messageText,
    ).toBeUndefined();
  });

  it('logs metadata only on sendGenericTemplate without persisting messageText', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(OK_RESPONSE);
    const logMessage = jest.fn().mockResolvedValue({});
    const repository = { logMessage };
    const configService = {
      get: (key: string) =>
        key === 'PAGE_ACCESS_TOKEN' ? 'page-token' : undefined,
    };
    const service = new MessengerOutboundService(
      configService as never,
      repository as never,
    );

    await service.sendGenericTemplate({
      psid: 'psid-test',
      messageType: 'REPORT_CAROUSEL',
      userId: 143,
      elements: [
        {
          title: 'Card 1',
          subtitle: 'Score report details',
        },
      ],
    });

    expect(logMessage).toHaveBeenCalledWith({
      userId: 143,
      psid: 'psid-test',
      messageType: 'REPORT_CAROUSEL',
      status: 'SENT',
    });
    expect(
      (logMessage.mock.calls[0][0] as Record<string, unknown>).messageText,
    ).toBeUndefined();
  });
});
