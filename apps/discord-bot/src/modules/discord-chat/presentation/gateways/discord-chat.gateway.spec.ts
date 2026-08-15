/* eslint-disable @typescript-eslint/unbound-method -- Jest mocks */
import type { ConfigService } from '@nestjs/config';
import type { PlatformAgentService } from '@wispace/chat-agent';
import type { PlatformChatHistoryService } from '@wispace/chat-agent';
import type { PlatformChatQueueService } from '@wispace/chat-agent';
import type { PlatformChatRateLimitService } from '@wispace/chat-metering';
import type { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import type { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import type { DiscordMenuService } from '../../application/services/discord-menu.service';
import type { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import type { DiscordWelcomeService } from '@discord/modules/account-link/application/services/discord-welcome.service';
import type { DiscordLinkVerifyRecordRepositoryPort } from '@discord/modules/account-link/domain/ports/discord-link-verify-record.repository.port';
import { DiscordChatGateway } from './discord-chat.gateway';

function buildConfigService(): ConfigService {
  return {
    get: () => undefined,
  } as unknown as ConfigService;
}

function buildGateway(overrides: {
  accountLink?: Partial<DiscordAccountLinkService>;
  outbound?: Partial<DiscordOutboundService>;
  welcome?: Partial<DiscordWelcomeService>;
  pendingVerify?: DiscordLinkVerifyRecordRepositoryPort['findPending'];
}): {
  gateway: DiscordChatGateway;
  accountLinkService: DiscordAccountLinkService;
  outboundService: DiscordOutboundService;
  welcomeService: DiscordWelcomeService;
  verifyRecordService: DiscordLinkVerifyRecordRepositoryPort;
} {
  const accountLinkService = {
    findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    ...overrides.accountLink,
  } as unknown as DiscordAccountLinkService;
  const outboundService = {
    sendMenuButtons: jest.fn().mockResolvedValue('dm-1'),
    sendToChannel: jest.fn().mockResolvedValue(undefined),
    ...overrides.outbound,
  } as unknown as DiscordOutboundService;
  const welcomeService = {
    welcomeIfDue: jest.fn().mockResolvedValue(true),
    ...overrides.welcome,
  } as unknown as DiscordWelcomeService;
  const verifyRecordService = {
    findPending:
      overrides.pendingVerify ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordLinkVerifyRecordRepositoryPort;

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
    verifyRecordService,
    welcomeService,
  );
  return {
    gateway,
    accountLinkService,
    outboundService,
    welcomeService,
    verifyRecordService,
  };
}

const member = {
  id: 'discord-user-1',
  displayName: 'Test User',
};

// necord's @Context() decorator passes the raw event args array — mimic it.
const memberArgs = [member] as never;

describe('DiscordChatGateway onGuildMemberAdd (#137 items 2+4)', () => {
  it('welcomes a linked user via the welcome service (deduped)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    };
    const welcome = { welcomeIfDue: jest.fn().mockResolvedValue(true) };
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      welcome,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.welcomeIfDue).toHaveBeenCalledWith(
      'discord-user-1',
      'Test User',
    );
  });

  it('skips the organic welcome when a fresh verify intent is pending (join-during-callback)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const pendingVerify = jest
      .fn()
      .mockResolvedValue({ userId: 143, verifiedAt: new Date() });
    const { gateway, outboundService } = buildGateway({
      accountLink,
      outbound,
      pendingVerify,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
  });

  it('sends the organic welcome when no verify intent is pending', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const { gateway, outboundService } = buildGateway({
      accountLink,
      outbound,
      pendingVerify: jest.fn().mockResolvedValue(undefined),
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('trợ lý WISPACE'),
    );
  });

  it('sends the organic welcome for stale pending intents (callback failed)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const outbound = { sendMenuButtons: jest.fn().mockResolvedValue('dm-1') };
    const pendingVerify = jest.fn().mockResolvedValue({
      userId: 143,
      verifiedAt: new Date(Date.now() - 10 * 60_000),
    });
    const { gateway, outboundService } = buildGateway({
      accountLink,
      outbound,
      pendingVerify,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('trợ lý WISPACE'),
    );
  });
});
