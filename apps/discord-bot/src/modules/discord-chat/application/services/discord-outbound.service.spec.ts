/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { Client } from 'discord.js';
import type { BotMetricsService } from '@wispace/bot-metrics';
import { DiscordOutboundService } from './discord-outbound.service';

function buildClientStub(fetch: jest.Mock): Client {
  return { users: { fetch } } as unknown as Client;
}

function buildMetricsStub(): BotMetricsService {
  return {
    incDmDeliveryFailure: jest.fn(),
  } as unknown as BotMetricsService;
}

type DiscordTextPayload = {
  content: string;
  nonce: string;
  enforceNonce: boolean;
};

describe('DiscordOutboundService', () => {
  it('fetches the Discord user and sends a DM', async () => {
    const send = jest
      .fn<Promise<{ channelId: string }>, [DiscordTextPayload]>()
      .mockResolvedValue({ channelId: 'dm-1' });
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    await service.sendText('discord-1', 'hello');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    const payload = send.mock.calls[0][0];
    expect(payload.content).toBe('hello');
    expect(payload.enforceNonce).toBe(true);
    expect(payload.nonce).toHaveLength(25);
  });

  it('throws when the DM fails to send after retries', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow(
      'Discord DM delivery failed',
    );
  });

  it('redacts the raw discord id from thrown delivery errors', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    const err = await service
      .sendText('discord-1', 'hello')
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('discord-1');
    expect((err as Error).message).toContain('di…');
  });

  it('sends a reschedule confirmation DM with confirm/cancel buttons', async () => {
    const send = jest
      .fn<Promise<void>, [{ content: string; components: unknown[] }]>()
      .mockResolvedValue(undefined);
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    await service.sendRescheduleConfirmation('discord-1', 'Dời buổi học?');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Dời buổi học?' }),
    );
    expect(send.mock.calls[0][0].components).toHaveLength(1);
  });

  it('#232: sendMenuButtons returns true when Discord acknowledges the send', async () => {
    const send = jest
      .fn<
        Promise<{ channelId: string }>,
        [{ content?: string; components: unknown[] }]
      >()
      .mockResolvedValue({ channelId: 'dm-1' });
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    const sent = await service.sendMenuButtons('discord-1', 'Chào bạn!');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Chào bạn!' }),
    );
    expect(send.mock.calls[0][0].components).toHaveLength(1);
    expect(sent).toBe(true);
  });

  it('#232: sendMenuButtons returns false (no throw) when the DM fails', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    await expect(
      service.sendMenuButtons('discord-1', 'Chào bạn!'),
    ).resolves.toBe(false);
  });

  it('swallows errors when the reschedule confirmation DM fails to send', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    await expect(
      service.sendRescheduleConfirmation('discord-1', 'Dời buổi học?'),
    ).resolves.toBeUndefined();
  });

  it('#137: counts DM delivery failures in metrics (privacy-blocked users)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    await service.sendMenuButtons('discord-1', 'menu');
    await service.sendRescheduleConfirmation('discord-1', 'confirm?');

    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith('dm_send_error');
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'menu_send_error',
    );
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'reschedule_send_error',
    );
  });

  it('#156: does NOT retry known 4xx API errors', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith('dm_send_error');
    expect(metrics.incDmDeliveryFailure).not.toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('#156: retries 5xx server errors', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Internal Server Error'), { status: 500 }),
      );
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(metrics.incDmDeliveryFailure).not.toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('#156: retries network failures and counts them as ambiguous (delivery outcome unknown)', async () => {
    const fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('#156: reuses the Discord nonce across a retry', async () => {
    const send = jest
      .fn<Promise<{ channelId: string }>, [DiscordTextPayload]>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ channelId: 'dm-1' });
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    await service.sendText('discord-1', 'hello');

    const firstPayload = send.mock.calls[0][0];
    const secondPayload = send.mock.calls[1][0];
    expect(firstPayload.enforceNonce).toBe(true);
    expect(secondPayload.enforceNonce).toBe(true);
    expect(secondPayload.nonce).toBe(firstPayload.nonce);
  });

  it('#156: does not retry an unknown non-network error', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('unexpected failure'));
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metrics.incDmDeliveryFailure).not.toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('#156: does not retry a timeout and records ambiguous delivery', async () => {
    const timeout = Object.assign(new Error('request timed out'), {
      name: 'TimeoutError',
    });
    const fetch = jest.fn().mockRejectedValue(timeout);
    const metrics = buildMetricsStub();

    const service = new DiscordOutboundService(
      buildClientStub(fetch),
      undefined,
      undefined,
      metrics,
    );

    await expect(service.sendText('discord-1', 'hello')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });
});
