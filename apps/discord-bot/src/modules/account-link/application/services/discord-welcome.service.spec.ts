/* eslint-disable @typescript-eslint/unbound-method -- Jest mock assertions */
import type { ConfigService } from '@nestjs/config';
import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import type { DiscordAccountLinkService } from './discord-account-link.service';
import { DiscordWelcomeService } from './discord-welcome.service';

function buildConfigService(): ConfigService {
  return {
    get: () => undefined,
  } as unknown as ConfigService;
}

describe('DiscordWelcomeService (#137 items 2+4)', () => {
  it('sends the welcome DM and marks the user welcomed when due', async () => {
    const accountLinkService = {
      shouldWelcome: jest.fn().mockResolvedValue(true),
      markWelcomed: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendMenuButtons: jest.fn().mockResolvedValue('dm-1'),
    } as unknown as DiscordOutboundService;
    const service = new DiscordWelcomeService(
      accountLinkService,
      outboundService,
      buildConfigService(),
    );

    const sent = await service.welcomeIfDue('discord-user-1', 'TestUser');

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('TestUser'),
    );
    expect(accountLinkService.markWelcomed).toHaveBeenCalledWith(
      'discord-user-1',
    );
    expect(sent).toBe(true);
  });

  it('skips the DM and the marker when welcomed within the window', async () => {
    const accountLinkService = {
      shouldWelcome: jest.fn().mockResolvedValue(false),
      markWelcomed: jest.fn().mockResolvedValue(undefined),
    } as unknown as DiscordAccountLinkService;
    const outboundService = {
      sendMenuButtons: jest.fn().mockResolvedValue('dm-1'),
    } as unknown as DiscordOutboundService;
    const service = new DiscordWelcomeService(
      accountLinkService,
      outboundService,
      buildConfigService(),
    );

    const sent = await service.welcomeIfDue('discord-user-1');

    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(accountLinkService.markWelcomed).not.toHaveBeenCalled();
    expect(sent).toBe(false);
  });
});
