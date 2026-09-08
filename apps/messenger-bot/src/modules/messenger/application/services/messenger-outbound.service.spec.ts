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

describe('MessengerOutboundService rich follow-up rate-limit admission (#622)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preflights the whole follow-up batch before sending any provider message', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(OK_RESPONSE);
    const admit = jest.fn().mockResolvedValue({
      allowed: false,
      outcome: 'limited',
      reason: 'cap_exceeded',
    });
    const service = new MessengerOutboundService(
      {
        get: (key: string) =>
          key === 'PAGE_ACCESS_TOKEN' ? 'page-token' : undefined,
      } as never,
      { logMessage: jest.fn() } as never,
      undefined,
      { admit } as never,
    );

    await expect(
      service.sendRichFollowUps({
        psid: 'psid-test',
        userId: 143,
        followUps: [
          {
            kind: 'button',
            messageType: 'BUTTON_PROMPT',
            text: 'Choose',
            buttons: [{ type: 'postback', title: 'One', payload: 'ONE' }],
          },
          {
            kind: 'generic',
            messageType: 'REPORT_CAROUSEL',
            elements: [{ title: 'Card' }],
          },
        ],
      }),
    ).resolves.toBe('rate_limited');

    expect(admit).toHaveBeenCalledWith({
      platform: 'messenger',
      externalUserId: 'psid-test',
      userId: 143,
      units: 2,
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

function buildHttpFailure(status: number): Response {
  return {
    ok: false,
    status,
    statusText: String(status),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

function buildLoggingService(): MessengerOutboundService {
  return new MessengerOutboundService(
    {
      get: (key: string) =>
        key === 'PAGE_ACCESS_TOKEN' ? 'page-token' : undefined,
    } as never,
    { logMessage: jest.fn().mockResolvedValue({}) } as never,
  );
}

describe('MessengerOutboundService Send-API breaker accounting (#517)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the breaker closed when a proactive wave hits deterministic 4xx users', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(buildHttpFailure(400));
    const service = buildLoggingService();

    // More per-user 4xx failures than the breaker volume threshold (5)
    for (let i = 0; i < 7; i += 1) {
      await expect(
        service.sendTextViaPsid({
          psid: `expired-psid-${i}`,
          text: 'Reminder',
          messageType: 'STUDY_REMINDER',
        }),
      ).rejects.toThrow(/HTTP 400/);
    }

    // A healthy user rides through the same wave — the breaker never opened
    globalFetch.mockResolvedValue(OK_RESPONSE);
    await expect(
      service.sendTextViaPsid({
        psid: 'healthy-psid',
        text: 'Reminder',
        messageType: 'STUDY_REMINDER',
      }),
    ).resolves.toBe('sent');
  });

  it('trips the breaker on transport/5xx waves and fails fast with the 503 surface', async () => {
    const globalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(buildHttpFailure(500));
    const service = buildLoggingService();

    // The first `volumeThreshold` calls reach the API and get HTTP 500
    for (let i = 0; i < 5; i += 1) {
      await expect(
        service.sendTextViaPsid({
          psid: `psid-${i}`,
          text: 'Reminder',
          messageType: 'STUDY_REMINDER',
        }),
      ).rejects.toThrow(/HTTP 500/);
    }

    // Circuit is now open — no further fetch attempts, 503 fail-fast surface
    globalFetch.mockClear();
    await expect(
      service.sendTextViaPsid({
        psid: 'healthy-psid',
        text: 'Reminder',
        messageType: 'STUDY_REMINDER',
      }),
    ).rejects.toThrow(/circuit breaker is OPEN/);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
