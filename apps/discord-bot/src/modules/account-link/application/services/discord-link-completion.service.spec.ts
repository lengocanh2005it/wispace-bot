/* eslint-disable @typescript-eslint/unbound-method -- Jest mocks */
import type { DiscordAccountLinkService } from './discord-account-link.service';
import type { DiscordGuildMembershipService } from './discord-guild-membership.service';
import type { DiscordRelinkNotifier } from './discord-relink-notifier.service';
import type { DiscordWelcomeService } from './discord-welcome.service';
import type { DiscordLinkVerifyRecordRepositoryPort } from '../../domain/ports/discord-link-verify-record.repository.port';
import type { WispaceTokenVerifyService } from '@wispace/wispace-client';
import { DiscordLinkCompletionService } from './discord-link-completion.service';

function buildHarness(overrides: {
  valid?: boolean;
  inGuild?: boolean;
  upsertResult?: { relinked: boolean; previousUserId?: number };
  upsertFailsFirst?: boolean;
  welcomeSent?: boolean;
}) {
  const accountLinkService = {
    exchangeCodeForDiscordUser: jest
      .fn()
      .mockResolvedValue({ id: 'discord-user-1', username: 'TestUser' }),
    upsertLink: overrides.upsertFailsFirst
      ? jest
          .fn()
          .mockRejectedValueOnce(new Error('db down'))
          .mockResolvedValueOnce(overrides.upsertResult ?? { relinked: false })
      : jest
          .fn()
          .mockResolvedValue(overrides.upsertResult ?? { relinked: false }),
  } as unknown as DiscordAccountLinkService;

  const tokenVerifyService = {
    verifyToken: jest
      .fn()
      .mockResolvedValue(
        overrides.valid === false
          ? { valid: false, reason: 'EXPIRED' }
          : { valid: true, userId: 143 },
      ),
  } as unknown as WispaceTokenVerifyService;

  const verifyRecordService = {
    recordVerify: jest.fn().mockResolvedValue(undefined),
    consumeRecord: jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordLinkVerifyRecordRepositoryPort;

  const guildMembershipService = {
    isMember: jest.fn().mockResolvedValue(overrides.inGuild ?? true),
  } as unknown as DiscordGuildMembershipService;

  const relinkNotifier = {
    notify: jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordRelinkNotifier;

  const welcomeService = {
    welcomeIfDue: jest.fn().mockResolvedValue(overrides.welcomeSent ?? true),
  } as unknown as DiscordWelcomeService;

  const service = new DiscordLinkCompletionService(
    accountLinkService,
    tokenVerifyService,
    verifyRecordService,
    guildMembershipService,
    relinkNotifier,
    welcomeService,
  );

  return {
    service,
    accountLinkService,
    tokenVerifyService,
    verifyRecordService,
    guildMembershipService,
    relinkNotifier,
    welcomeService,
  };
}

describe('DiscordLinkCompletionService', () => {
  it('verifies, records the intent before the upsert, then consumes it', async () => {
    const {
      service,
      tokenVerifyService,
      verifyRecordService,
      accountLinkService,
    } = buildHarness({});

    const outcome = await service.completeLink('code', 'good-token');

    expect(tokenVerifyService.verifyToken).toHaveBeenCalledWith(
      'good-token',
      'discord-user-1',
    );
    expect(verifyRecordService.recordVerify).toHaveBeenCalledWith(
      'discord-user-1',
      143,
    );
    expect(accountLinkService.upsertLink).toHaveBeenCalledWith(
      143,
      'discord-user-1',
    );
    expect(verifyRecordService.consumeRecord).toHaveBeenCalledWith(
      'discord-user-1',
    );
    expect(outcome).toBe('success');
  });

  it('retries the upsert on transient DB failure (token already consumed)', async () => {
    const { service, accountLinkService } = buildHarness({
      upsertFailsFirst: true,
    });

    await service.completeLink('code', 'good-token');

    expect(accountLinkService.upsertLink).toHaveBeenCalledTimes(2);
  });

  it('throws when the WISPACE token is invalid (controller maps to error redirect)', async () => {
    const { service, accountLinkService, verifyRecordService } = buildHarness({
      valid: false,
    });

    await expect(service.completeLink('code', 'bad-token')).rejects.toThrow(
      'token rejected',
    );
    expect(accountLinkService.upsertLink).not.toHaveBeenCalled();
    expect(verifyRecordService.recordVerify).not.toHaveBeenCalled();
  });

  it('notifies when the link displaced another WISPACE user', async () => {
    const { service, relinkNotifier } = buildHarness({
      upsertResult: { relinked: true, previousUserId: 99 },
    });

    await service.completeLink('code', 'good-token');

    expect(relinkNotifier.notify).toHaveBeenCalledWith('discord-user-1', 99);
  });

  it('welcomes (deduped) when already in the guild, then reports success', async () => {
    const { service, welcomeService } = buildHarness({ inGuild: true });

    const outcome = await service.completeLink('code', 'good-token');

    expect(welcomeService.welcomeIfDue).toHaveBeenCalledWith(
      'discord-user-1',
      'TestUser',
    );
    expect(outcome).toBe('success');
  });

  it('#233: a welcome deduped by the shared record (organic preceded the link) still completes the link without a second DM', async () => {
    const { service, welcomeService } = buildHarness({
      inGuild: true,
      welcomeSent: false,
    });

    const outcome = await service.completeLink('code', 'good-token');

    expect(welcomeService.welcomeIfDue).toHaveBeenCalledTimes(1);
    // The welcome service returned false = deduped (organic welcome was sent
    // within the window); the link itself is still committed and reported.
    expect(outcome).toBe('success');
  });

  it('reports not-in-guild without welcoming when the user is not in the guild yet', async () => {
    const { service, welcomeService } = buildHarness({ inGuild: false });

    const outcome = await service.completeLink('code', 'good-token');

    expect(welcomeService.welcomeIfDue).not.toHaveBeenCalled();
    expect(outcome).toBe('not-in-guild');
  });
});
