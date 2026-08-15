import type { ConfigService } from '@nestjs/config';
import type { PlatformAgentService } from '@wispace/chat-agent';
import type { PlatformChatHistoryService } from '@wispace/chat-agent';
import type { PlatformChatQueueService } from '@wispace/chat-agent';
import type { PlatformChatRateLimitService } from '@wispace/chat-metering';
import type { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import type { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import type { DiscordMenuService } from '../../application/services/discord-menu.service';
import type { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordChatGateway } from './discord-chat.gateway';

function buildConfigService(): ConfigService {
  return {
    get: () => undefined,
  } as unknown as ConfigService;
}

function buildGateway(overrides: {
  accountLink?: Partial<DiscordAccountLinkService>;
  outbound?: Partial<DiscordOutboundService>;
}): DiscordChatGateway {
  const accountLinkService = {
    findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    shouldWelcome: jest.fn().mockResolvedValue(true),
    markWelcomed: jest.fn().mockResolvedValue(undefined),
    ...overrides.accountLink,
  } as unknown as DiscordAccountLinkService;
  const outboundService = {
    sendMenuButtons: jest.fn().mockResolvedValue('dm-1'),
    sendToChannel: jest.fn().mockResolvedValue(undefined),
    ...overrides.outbound,
  } as unknown as DiscordOutboundService;

  const gateway = new DiscordChatGateway(
    buildConfigService(),
    {} as PlatformAgentService,
    outboundService,
    {} as PlatformChatRateLimitService,
    accountLinkService,
    {} as RescheduleConfirmationService<string>,
    {} as DiscordMenuService,
    {} as PlatformChatHistoryService,
    {} as PlatformChatQueueService,
  );
  return gateway;
}

const member = {
  id: 'discord-user-1',
  displayName: 'Test User',
};

// necord's @Context() decorator passes the raw event args array — mimic it.
const memberArgs = [member] as never;

describe('DiscordChatGateway onGuildMemberAdd (#137 items 2+4)', () => {
  it('welcomes a linked user when not welcomed within the window', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
      shouldWelcome: jest.fn().mockResolvedValue(true),
      markWelcomed: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const gateway = buildGateway({ accountLink, outbound });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outbound.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('WISPACE'),
    );
    expect(accountLink.markWelcomed).toHaveBeenCalledWith('discord-user-1');
  });

  it('skips the welcome DM when the user was welcomed within the window (re-join / join-during-callback)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
      shouldWelcome: jest.fn().mockResolvedValue(false),
      markWelcomed: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const gateway = buildGateway({ accountLink, outbound });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outbound.sendMenuButtons).not.toHaveBeenCalled();
    expect(accountLink.markWelcomed).not.toHaveBeenCalled();
  });

  it('still sends the organic welcome for unlinked users (no marker involved)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
      shouldWelcome: jest.fn().mockResolvedValue(true),
      markWelcomed: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const gateway = buildGateway({ accountLink, outbound });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outbound.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('trợ lý WISPACE'),
    );
    expect(accountLink.markWelcomed).not.toHaveBeenCalled();
  });
});
