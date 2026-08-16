/* eslint-disable @typescript-eslint/unbound-method -- Jest mock assertions */
import type { ConfigService } from '@nestjs/config';
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordWelcomeRecordRepositoryPort } from '../../domain/ports/discord-welcome-record.repository.port';
import { DiscordWelcomeService } from './discord-welcome.service';

function buildConfigService(): ConfigService {
  return {
    get: () => undefined,
  } as unknown as ConfigService;
}

function buildMocks() {
  const welcomeRecords = {
    tryClaimWelcome: jest.fn().mockResolvedValue(true),
    markWelcomed: jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordWelcomeRecordRepositoryPort;
  const outboundService = {
    sendMenuButtons: jest.fn().mockResolvedValue(true),
  } as unknown as DiscordOutboundService;
  const metrics = {
    incWelcomeAttempt: jest.fn(),
  } as unknown as BotMetricsService;
  return { welcomeRecords, outboundService, metrics };
}

describe('DiscordWelcomeService (#231/#232/#233)', () => {
  it('sends the linked welcome and marks the record when due', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const outcome = await service.welcomeIfDue('discord-user-1', 'TestUser');

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('TestUser'),
    );
    expect(welcomeRecords.markWelcomed).toHaveBeenCalledWith(
      'discord-user-1',
      'linked',
    );
    expect(metrics.incWelcomeAttempt).toHaveBeenCalledWith('success');
    expect(outcome).toBe('sent');
  });

  it('skips the DM and the marker when the claim is lost (welcomed within the window)', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    welcomeRecords.tryClaimWelcome = jest.fn().mockResolvedValue(false);
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const outcome = await service.welcomeIfDue('discord-user-1');

    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(welcomeRecords.markWelcomed).not.toHaveBeenCalled();
    expect(metrics.incWelcomeAttempt).toHaveBeenCalledWith('skipped');
    expect(outcome).toBe('skipped');
  });

  it('#232: a failed send is not marked welcomed — the next event retries', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    outboundService.sendMenuButtons = jest.fn().mockResolvedValue(false);
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const outcome = await service.welcomeIfDue('discord-user-1');

    expect(outboundService.sendMenuButtons).toHaveBeenCalledTimes(1);
    expect(welcomeRecords.markWelcomed).not.toHaveBeenCalled();
    expect(metrics.incWelcomeAttempt).toHaveBeenCalledWith('error');
    expect(outcome).toBe('error');
  });

  it('#231: organic welcome uses the greeting copy and marks as organic', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const outcome = await service.sendOrganicWelcomeIfDue(
      'discord-user-1',
      'OrganicUser',
    );

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('OrganicUser'),
    );
    expect(welcomeRecords.markWelcomed).toHaveBeenCalledWith(
      'discord-user-1',
      'organic',
    );
    expect(outcome).toBe('sent');
  });

  it('#233: organic then linked within the window yields exactly one DM', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    // First call (organic join) wins the claim; the shared record then says
    // "recently welcomed" for the linked path — the callback loses the claim
    // and must not send a second DM.
    welcomeRecords.tryClaimWelcome = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const organic = await service.sendOrganicWelcomeIfDue(
      'discord-user-1',
      'User',
    );
    const linked = await service.welcomeIfDue('discord-user-1', 'User');

    expect(organic).toBe('sent');
    expect(linked).toBe('skipped');
    expect(outboundService.sendMenuButtons).toHaveBeenCalledTimes(1);
    expect(welcomeRecords.markWelcomed).toHaveBeenCalledTimes(1);
  });

  it('#159: concurrent OAuth callback + guildMemberAdd — only the claim winner sends', async () => {
    const { welcomeRecords, outboundService, metrics } = buildMocks();
    // Simulates the atomic conditional upsert: exactly one of the two racing
    // events wins the claim (the other loses, as the DB predicate decides).
    welcomeRecords.tryClaimWelcome = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
      metrics,
    );

    const [callbackOutcome, joinOutcome] = await Promise.all([
      service.welcomeIfDue('discord-user-1', 'User'),
      service.welcomeIfDue('discord-user-1', 'User'),
    ]);

    expect([callbackOutcome, joinOutcome].sort()).toEqual(['sent', 'skipped']);
    expect(outboundService.sendMenuButtons).toHaveBeenCalledTimes(1);
    expect(welcomeRecords.markWelcomed).toHaveBeenCalledTimes(1);
    expect(metrics.incWelcomeAttempt).toHaveBeenCalledWith('success');
    expect(metrics.incWelcomeAttempt).toHaveBeenCalledWith('skipped');
  });

  it('works without a metrics service (optional dependency)', async () => {
    const { welcomeRecords, outboundService } = buildMocks();
    const service = new DiscordWelcomeService(
      welcomeRecords,
      outboundService,
      buildConfigService(),
    );

    await expect(
      service.sendOrganicWelcomeIfDue('discord-user-1'),
    ).resolves.toBe('sent');
  });
});
