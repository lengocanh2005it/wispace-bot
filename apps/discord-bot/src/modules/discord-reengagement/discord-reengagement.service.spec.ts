/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { HttpStatus, RequestMethod } from '@nestjs/common';
import { InternalApiKeyGuard } from '@wispace/bot-common/guard';
import type { BotMetricsService } from '@wispace/bot-metrics';
import { WispaceApiError } from '@wispace/wispace-client/core';
import type { ReengagementApiClient } from '@wispace/wispace-client/core';
import type { DiscordOutboundService } from '../discord-chat/application/services/discord-outbound.service';
import type { DiscordAccountLinkService } from '../account-link/application/services/discord-account-link.service';
import { DiscordReengagementService } from './discord-reengagement.service';
import { DiscordReengagementController } from './discord-reengagement.controller';

const PAYLOAD = {
  variant: 'b' as const,
  period: 'last-1-month',
  is_fallback: true,
  summary: { totalEssays: 2 },
  discord_payload: {
    embeds: [{ title: 'Bạn đã nghỉ 12 ngày rồi nha' }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, label: 'Mở WISPACE', url: 'https://wispace.example.com' },
        ],
      },
    ],
  },
};

type Stubs = {
  client: { getPayload: jest.Mock; markSent: jest.Mock };
  accountLink: { findDiscordIdByUserId: jest.Mock };
  outbound: { sendProactivePayload: jest.Mock };
  metrics: { incReengagementSend: jest.Mock };
};

function buildStubs(): Stubs {
  return {
    client: {
      getPayload: jest.fn().mockResolvedValue(PAYLOAD),
      markSent: jest.fn().mockResolvedValue({ success: true, logId: 'log-1' }),
    },
    accountLink: {
      findDiscordIdByUserId: jest.fn().mockResolvedValue('discord-1'),
    },
    outbound: {
      sendProactivePayload: jest
        .fn()
        .mockResolvedValue({ outcome: 'sent', messageId: 'msg-1' }),
    },
    metrics: { incReengagementSend: jest.fn() },
  };
}

function buildService(stubs: Stubs): DiscordReengagementService {
  return new DiscordReengagementService(
    stubs.client as unknown as ReengagementApiClient,
    stubs.outbound as unknown as DiscordOutboundService,
    stubs.accountLink as unknown as DiscordAccountLinkService,
    stubs.metrics as unknown as BotMetricsService,
  );
}

describe('DiscordReengagementService.runOnce', () => {
  let stubs: Stubs;

  beforeEach(() => {
    stubs = buildStubs();
  });

  it('runs payload → DM → markSent SUCCESS and returns the message id', async () => {
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(stubs.accountLink.findDiscordIdByUserId).toHaveBeenCalledWith(42);
    expect(stubs.client.getPayload).toHaveBeenCalledWith('42', {
      platform: 'discord',
    });
    expect(stubs.outbound.sendProactivePayload).toHaveBeenCalledWith(
      'discord-1',
      PAYLOAD.discord_payload,
      { userId: 42 },
    );
    expect(stubs.client.markSent).toHaveBeenCalledWith({
      userId: '42',
      platform: 'discord',
      variant: 'b',
      status: 'SUCCESS',
      messageId: 'msg-1',
    });
    expect(result).toEqual({
      outcome: 'sent',
      messageId: 'msg-1',
      markSent: { success: true, logId: 'log-1' },
    });
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('sent');
  });

  it('fails with not_linked before calling the payload API', async () => {
    stubs.accountLink.findDiscordIdByUserId.mockResolvedValue(undefined);
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('not_linked');
    expect(stubs.client.getPayload).not.toHaveBeenCalled();
    expect(stubs.client.markSent).not.toHaveBeenCalled();
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('failed');
  });

  it.each([
    ['404', 404],
    ['401', 401],
  ] as const)(
    'fails on payload %s without calling markSent',
    async (_l, status) => {
      stubs.client.getPayload.mockRejectedValue(
        new WispaceApiError('err', status, '', 'Reengagement/payload'),
      );
      const service = buildService(stubs);

      const result = await service.runOnce(42);

      expect(result.outcome).toBe('failed');
      expect(result.reason).toContain(String(status));
      expect(stubs.outbound.sendProactivePayload).not.toHaveBeenCalled();
      expect(stubs.client.markSent).not.toHaveBeenCalled();
      expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('failed');
    },
  );

  it('marks FAILED (does not throw) when the DM is blocked (50007)', async () => {
    stubs.outbound.sendProactivePayload.mockResolvedValue({
      outcome: 'not_sent',
    });
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(result.outcome).toBe('failed');
    expect(stubs.client.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('failed');
  });

  it('marks SUCCESS on an ambiguous send (anti-duplicate bias)', async () => {
    stubs.outbound.sendProactivePayload.mockResolvedValue({
      outcome: 'ambiguous',
    });
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(result.outcome).toBe('ambiguous');
    expect(stubs.client.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCESS' }),
    );
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith('ambiguous');
  });

  it('marks FAILED on rate_limited', async () => {
    stubs.outbound.sendProactivePayload.mockResolvedValue({
      outcome: 'rate_limited',
    });
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(result.outcome).toBe('rate_limited');
    expect(stubs.client.markSent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('surfaces a mark-sent failure after a successful send', async () => {
    stubs.client.markSent.mockRejectedValue(
      new WispaceApiError('boom', 503, '', 'Reengagement/mark-sent'),
    );
    const service = buildService(stubs);

    const result = await service.runOnce(42);

    expect(result.outcome).toBe('sent');
    expect(result.messageId).toBe('msg-1');
    expect(result.reason).toContain('mark-sent');
    expect(stubs.metrics.incReengagementSend).toHaveBeenCalledWith(
      'mark_sent_error',
    );
  });

  it('a dormant learner still receives the DM — no dormancy gate on this path', async () => {
    // #595 regression pin: the re-engagement orchestration never consults
    // WebActivityService — a dormant learner is a valid recipient.
    const { WebActivityService } = jest.requireActual('@wispace/database');
    const filterDormantSpy = jest.spyOn(
      WebActivityService.prototype,
      'filterDormant',
    );
    const service = buildService(stubs);

    await service.runOnce(42);

    expect(filterDormantSpy).not.toHaveBeenCalled();
    expect(stubs.outbound.sendProactivePayload).toHaveBeenCalledTimes(1);
    filterDormantSpy.mockRestore();
  });
});

describe('DiscordReengagementController', () => {
  const runOnce = jest.fn();

  const controller = new DiscordReengagementController({
    runOnce,
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is protected by InternalApiKeyGuard at controller level', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      DiscordReengagementController,
    );
    expect(guards).toContain(InternalApiKeyGuard);
  });

  it('binds POST reengagement/run-once with 200', () => {
    const handler = DiscordReengagementController.prototype.runOnce;
    expect(Reflect.getMetadata('path', handler)).toBe('reengagement/run-once');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
  });

  it('delegates with the provided userId', async () => {
    runOnce.mockResolvedValue({ outcome: 'sent', messageId: 'msg-1' });

    const result = await controller.runOnce({ userId: 42 });

    expect(runOnce).toHaveBeenCalledWith(42);
    expect(result).toEqual({ outcome: 'sent', messageId: 'msg-1' });
  });

  it('rejects a missing or non-positive userId with 400', async () => {
    await expect(controller.runOnce({} as never)).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });
    await expect(controller.runOnce({ userId: 0 })).rejects.toMatchObject({
      getStatus: expect.any(Function),
    });
    expect(runOnce).not.toHaveBeenCalled();
  });
});
