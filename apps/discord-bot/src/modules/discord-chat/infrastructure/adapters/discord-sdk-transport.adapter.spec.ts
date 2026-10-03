import { ConfigService } from '@nestjs/config';
import { DiscordSendTimeoutError } from '../../domain/discord-send-outcome.errors';
import { resolveDiscordSendTimeoutMs } from '../../domain/discord-send-timeout';
import { DiscordSdkTransportAdapter } from './discord-sdk-transport.adapter';

function buildAdapter(post: jest.Mock, timeoutMs?: string) {
  const config = {
    get: (key: string) =>
      key === 'DISCORD_SEND_TIMEOUT_MS' ? timeoutMs : undefined,
  } as unknown as ConfigService;
  // `MessagePayload` reads the client's json transformer while building a
  // body, so the stub has to carry the shape it reaches for.
  const client: Record<string, unknown> = {
    rest: { post },
    options: { jsonTransformer: (value: unknown) => value },
  };
  const channel = { id: 'dm-channel', client };
  const user = {
    id: 'discord-1',
    client,
    createDM: jest.fn().mockResolvedValue(channel),
  };
  client.users = { fetch: jest.fn().mockResolvedValue(user) };
  client.channels = { fetch: jest.fn().mockResolvedValue(channel) };
  return {
    adapter: new DiscordSdkTransportAdapter(client as never, config),
  };
}

describe('DiscordSdkTransportAdapter (#1509)', () => {
  it('resolves DISCORD_SEND_TIMEOUT_MS, defaulting to the pre-#1509 behaviour', () => {
    const withValue = { get: () => '9000' } as unknown as ConfigService;
    const withoutValue = { get: () => undefined } as unknown as ConfigService;
    const invalid = { get: () => 'not-a-number' } as unknown as ConfigService;

    expect(resolveDiscordSendTimeoutMs(withValue)).toBe(9000);
    expect(resolveDiscordSendTimeoutMs(withoutValue)).toBe(15_000);
    expect(resolveDiscordSendTimeoutMs(invalid)).toBe(15_000);
  });

  it('builds the request through MessagePayload and passes a composed signal', async () => {
    const post = jest.fn().mockResolvedValue({ id: 'sent-1' });
    const { adapter } = buildAdapter(post, '15000');

    const result = await adapter.sendDirectMessage('discord-1', {
      content: 'hello',
      allowedMentions: { parse: [], roles: [], users: [], repliedUser: false },
      nonce: 'n1',
      enforceNonce: true,
    });

    expect(result).toEqual({ id: 'sent-1', channelId: 'dm-channel' });
    const [, request] = post.mock.calls[0];
    expect(request.body).toMatchObject({ content: 'hello', nonce: 'n1' });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal.aborted).toBe(false);
  });

  it('attributes a stalled send to the deadline, not the caller (#1509)', async () => {
    // A real stall: the request ignores the signal and the deadline is what
    // ends it. The SDK's own abort then arrives with no reason attached.
    const post = jest.fn().mockImplementation(
      (_route: string, request: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('This operation was aborted'), {
                name: 'AbortError',
              }),
            ),
          );
        }),
    );
    const { adapter } = buildAdapter(post, '5');

    await expect(
      adapter.sendDirectMessage('discord-1', {
        content: 'hello',
        allowedMentions: {
          parse: [],
          roles: [],
          users: [],
          repliedUser: false,
        },
      }),
    ).rejects.toBeInstanceOf(DiscordSendTimeoutError);
  });

  it('leaves an abort it cannot attribute to the deadline untouched (#1509)', async () => {
    // Attribution must not claim every abort: a send that failed fast, well
    // inside the deadline, did not time out and must not be relabelled as one.
    const abort = Object.assign(new Error('This operation was aborted'), {
      name: 'AbortError',
    });
    const post = jest.fn().mockRejectedValue(abort);
    const { adapter } = buildAdapter(post, '15000');

    await expect(
      adapter.sendDirectMessage('discord-1', {
        content: 'hello',
        allowedMentions: {
          parse: [],
          roles: [],
          users: [],
          repliedUser: false,
        },
      }),
    ).rejects.toBe(abort);
  });

  it('sends the typing indicator through the same deadline', async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const { adapter } = buildAdapter(post, '15000');

    await adapter.sendTypingIndicator('discord-1');

    const [route, request] = post.mock.calls[0];
    expect(route).toBe('/channels/dm-channel/typing');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a non-abort error through unchanged', async () => {
    const notFound = Object.assign(new Error('Unknown Channel'), {
      status: 404,
    });
    const post = jest.fn().mockRejectedValue(notFound);
    const { adapter } = buildAdapter(post, '15000');

    await expect(
      adapter.sendDirectMessage('discord-1', {
        content: 'hello',
        allowedMentions: {
          parse: [],
          roles: [],
          users: [],
          repliedUser: false,
        },
      }),
    ).rejects.toBe(notFound);
  });
});
