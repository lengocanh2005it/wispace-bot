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
import { ChannelType } from 'discord.js';

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
    sendConsentExplainerIfDue: jest.fn().mockResolvedValue(true),
    ...overrides.accountLink,
  } as unknown as DiscordAccountLinkService;
  const outboundService = {
    sendMenuButtons: jest.fn().mockResolvedValue(true),
    sendToChannel: jest.fn().mockResolvedValue(undefined),
    ...overrides.outbound,
  } as unknown as DiscordOutboundService;
  const welcomeService = {
    welcomeIfDue: jest.fn().mockResolvedValue('sent'),
    sendOrganicWelcomeIfDue: jest.fn().mockResolvedValue('sent'),
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
    {
      handleIfConsentCommand: jest.fn().mockResolvedValue(false),
    } as never,
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

describe('DiscordChatGateway onGuildMemberAdd (#137 items 2+4, #231/#232/#234)', () => {
  it('welcomes a linked user via the welcome service (deduped)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    };
    const welcome = { welcomeIfDue: jest.fn().mockResolvedValue('sent') };
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      welcome,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.welcomeIfDue).toHaveBeenCalledWith(
      'discord-user-1',
      'Test User',
    );
    expect(welcomeService.sendOrganicWelcomeIfDue).not.toHaveBeenCalled();
  });

  it('skips the organic welcome when a fresh verify intent is pending (join-during-callback)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const pendingVerify = jest
      .fn()
      .mockResolvedValue({ userId: 143, verifiedAt: new Date() });
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      pendingVerify,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).not.toHaveBeenCalled();
  });

  it('#231: routes the organic welcome through the shared dedupe service', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      pendingVerify: jest.fn().mockResolvedValue(undefined),
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).toHaveBeenCalledWith(
      'discord-user-1',
      'Test User',
    );
    // The gateway itself never sends the DM — dedupe lives in the service.
  });

  it('#231: a second join within the window is deduped by the service — no DM', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const welcome = {
      sendOrganicWelcomeIfDue: jest
        .fn()
        .mockResolvedValueOnce('sent')
        .mockResolvedValueOnce('skipped'),
    };
    const outbound = { sendMenuButtons: jest.fn() };
    const { gateway, welcomeService, outboundService } = buildGateway({
      accountLink,
      welcome,
      outbound,
    });

    await gateway.onGuildMemberAdd(memberArgs);
    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).toHaveBeenCalledTimes(2);
    // DM delivery happens inside the service; a deduped join sends nothing.
    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
  });

  it('#231: a re-join after the window is welcomed again', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const welcome = {
      sendOrganicWelcomeIfDue: jest.fn().mockResolvedValue('sent'),
    };
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      welcome,
    });

    await gateway.onGuildMemberAdd(memberArgs);
    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).toHaveBeenCalledTimes(2);
  });

  it('#233: organic join then link route through the same welcome service — never a second direct DM', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(143),
    };
    const outbound = { sendMenuButtons: jest.fn() };
    const { gateway, welcomeService, outboundService } = buildGateway({
      accountLink,
      outbound,
    });

    // 1) Unlinked join → organic welcome path.
    await gateway.onGuildMemberAdd(memberArgs);
    // 2) The user completes the OAuth link in-guild → linked welcome path.
    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).toHaveBeenCalledTimes(1);
    expect(welcomeService.welcomeIfDue).toHaveBeenCalledTimes(1);
    // Both paths delegate to the shared dedupe service; the gateway itself
    // never sends the DM a second time.
    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
  });

  it('sends the organic welcome for stale pending intents (callback failed)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(undefined),
    };
    const pendingVerify = jest.fn().mockResolvedValue({
      userId: 143,
      verifiedAt: new Date(Date.now() - 10 * 60_000),
    });
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      pendingVerify,
    });

    await gateway.onGuildMemberAdd(memberArgs);

    expect(welcomeService.sendOrganicWelcomeIfDue).toHaveBeenCalledWith(
      'discord-user-1',
      'Test User',
    );
  });

  it('#234: a repository failure resolves the handler (no unhandled rejection)', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockRejectedValue(new Error('DB blip')),
    };
    const welcome = { welcomeIfDue: jest.fn() };
    const { gateway, welcomeService } = buildGateway({
      accountLink,
      welcome,
    });

    await expect(gateway.onGuildMemberAdd(memberArgs)).resolves.toBeUndefined();

    // Mapping lookup failed → the DM path still runs (organic fallback) but
    // the handler never throws.
    expect(welcomeService.welcomeIfDue).not.toHaveBeenCalled();
  });

  it('#234: a DM-path failure is caught — the handler resolves and logs', async () => {
    const accountLink = {
      findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    };
    const welcome = {
      welcomeIfDue: jest.fn().mockRejectedValue(new Error('DM send blew up')),
    };
    const { gateway } = buildGateway({
      accountLink,
      welcome,
    });

    await expect(gateway.onGuildMemberAdd(memberArgs)).resolves.toBeUndefined();
  });
});

describe('DiscordChatGateway non-text messages (#401)', () => {
  it('sends the bounded shared fallback for a DM attachment without queueing', async () => {
    const { gateway, outboundService } = buildGateway({});
    const message = {
      author: { bot: false, id: 'discord-user-1' },
      channel: { type: ChannelType.DM },
      content: '',
      attachments: { size: 1 },
      stickers: { size: 0 },
      embeds: [],
      mentions: { users: new Map() },
      client: { user: null },
    };

    await gateway.onMessageCreate([message] as never);

    expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('tin nhắn chữ'),
    );
  });
});
