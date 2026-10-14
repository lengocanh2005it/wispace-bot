import type { ConfigService } from '@nestjs/config';
import type { PlatformChatQueueService } from '@wispace/chat-agent';
import type { RescheduleConfirmationService } from '@wispace/reschedule-confirm/core';
import type { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import type { DiscordMenuService } from '../../application/services/discord-menu.service';
import type { DiscordLinkedIdentityPort } from '../../domain/ports/discord-linked-identity.port';
import type { DiscordConsentPromptPort } from '../../application/ports/discord-consent-prompt.port';
import type { DiscordWelcomeDeliveryPort } from '../../application/ports/discord-welcome-delivery.port';
import type { DiscordLinkVerifyRecordRepositoryPort } from '@discord/modules/account-link/domain/ports/discord-link-verify-record.repository.port';
import { prepareDiscordOutbound } from '../../application/utils/discord-outbound-guard';
import { CHAT_FAILURE_FALLBACK_MESSAGE } from '@wispace/llm-agent/core';
import { DiscordChatGateway } from './discord-chat.gateway';
import { ChannelType } from 'discord.js';

function buildConfigService(): ConfigService {
  return {
    get: () => undefined,
  } as unknown as ConfigService;
}

function buildGateway(overrides: {
  accountLink?: Partial<DiscordLinkedIdentityPort>;
  outbound?: Partial<DiscordOutboundService>;
  welcome?: Partial<DiscordWelcomeDeliveryPort>;
  menu?: Partial<DiscordMenuService>;
  chatQueue?: Partial<PlatformChatQueueService>;
  reschedule?: Partial<RescheduleConfirmationService<string>>;
  pendingVerify?: DiscordLinkVerifyRecordRepositoryPort['findPending'];
}): {
  gateway: DiscordChatGateway;
  accountLinkService: DiscordLinkedIdentityPort;
  consentPrompt: DiscordConsentPromptPort;
  outboundService: DiscordOutboundService;
  welcomeService: DiscordWelcomeDeliveryPort;
  chatQueueService: PlatformChatQueueService;
  verifyRecordService: DiscordLinkVerifyRecordRepositoryPort;
} {
  const accountLinkService = {
    findUserIdByDiscordId: jest.fn().mockResolvedValue(143),
    findCurrentIdentity: jest.fn().mockResolvedValue(undefined),
    ...overrides.accountLink,
  } as unknown as DiscordLinkedIdentityPort;
  const consentPrompt = {
    sendConsentExplainerIfDue: jest.fn().mockResolvedValue(true),
  } as unknown as DiscordConsentPromptPort;
  const outboundService = {
    prepareText: jest.fn((text: string) => ({
      content: text,
      allowedMentions: {
        parse: [],
        roles: [],
        users: [],
        repliedUser: false,
      },
    })),
    sendMenuButtons: jest.fn().mockResolvedValue(true),
    sendText: jest.fn().mockResolvedValue(undefined),
    sendToChannel: jest.fn().mockResolvedValue(undefined),
    admitOutbound: jest.fn().mockResolvedValue(true),
    ...overrides.outbound,
  } as unknown as DiscordOutboundService;
  const welcomeService = {
    welcomeIfDue: jest.fn().mockResolvedValue('sent'),
    sendOrganicWelcomeIfDue: jest.fn().mockResolvedValue('sent'),
    ...overrides.welcome,
  } as unknown as DiscordWelcomeDeliveryPort;
  const verifyRecordService = {
    findPending:
      overrides.pendingVerify ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as DiscordLinkVerifyRecordRepositoryPort;
  const menuService = {
    getUpcomingSessions: jest.fn().mockResolvedValue('upcoming'),
    getLearningProgress: jest.fn().mockResolvedValue('progress'),
    ...overrides.menu,
  } as unknown as DiscordMenuService;
  const chatQueueService = {
    enqueue: jest.fn().mockResolvedValue(undefined),
    ...overrides.chatQueue,
  } as unknown as PlatformChatQueueService;

  const gateway = new DiscordChatGateway(
    buildConfigService(),
    outboundService,
    accountLinkService,
    (overrides.reschedule as
      | RescheduleConfirmationService<string>
      | undefined) ?? ({} as RescheduleConfirmationService<string>),
    menuService,
    chatQueueService,
    {
      handleIfConsentCommand: jest.fn().mockResolvedValue(false),
    } as never,
    verifyRecordService,
    welcomeService,
    consentPrompt,
  );
  return {
    gateway,
    accountLinkService,
    consentPrompt,
    outboundService,
    welcomeService,
    chatQueueService,
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
      143,
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

  it('guards direct server replies with Discord mention policy', async () => {
    const prepareText = jest.fn((text: string) => ({
      content: '[safe] ' + text,
      allowedMentions: {
        parse: [],
        roles: [],
        users: [],
        repliedUser: false,
      },
    }));
    const reply = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({ outbound: { prepareText } });
    const message = {
      author: { bot: false, id: 'discord-user-1' },
      channel: { type: ChannelType.GuildText },
      content: '',
      attachments: { size: 1 },
      stickers: { size: 0 },
      embeds: [],
      mentions: { users: new Map([['bot-1', {}]]) },
      client: { user: { id: 'bot-1' } },
      reply,
    };

    await gateway.onMessageCreate([message] as never);

    expect(prepareText).toHaveBeenCalledWith(
      expect.stringContaining('tin nhắn chữ'),
      { externalUserId: 'discord-user-1' },
    );
    expect(reply).toHaveBeenCalledWith({
      content: expect.stringContaining('[safe]'),
      allowedMentions: {
        parse: [],
        roles: [],
        users: [],
        repliedUser: false,
      },
    });
  });

  it('guards direct interaction edits with Discord mention policy', async () => {
    const prepareText = jest.fn((text: string) => {
      const prepared = prepareDiscordOutbound(text);
      return {
        content: prepared.content,
        allowedMentions: prepared.allowedMentions,
      };
    });
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({
      outbound: { prepareText },
      menu: {
        getUpcomingSessions: jest.fn().mockResolvedValue('@everyone'),
      },
    });
    const interaction = {
      user: { id: 'discord-user-1' },
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply,
      isButton: () => true,
    };

    await gateway.onMenuUpcomingSessions([interaction] as never);

    expect(prepareText).toHaveBeenCalledWith('@everyone', {
      externalUserId: 'discord-user-1',
    });
    expect(editReply).toHaveBeenCalledWith({
      content: '[mọi người]',
      allowedMentions: {
        parse: [],
        roles: [],
        users: [],
        repliedUser: false,
      },
    });
  });
});

describe('DiscordChatGateway menu admission (#1508)', () => {
  const interaction = (editReply: jest.Mock) =>
    ({
      user: { id: 'discord-user-1' },
      isButton: () => true,
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply,
    }) as never;

  const buildDenied = (menu: Partial<DiscordMenuService>) => {
    const getUpcomingSessions = jest.fn().mockResolvedValue('upcoming');
    const getLearningProgress = jest.fn().mockResolvedValue('progress');
    const { gateway, outboundService } = buildGateway({
      outbound: { admitOutbound: jest.fn().mockResolvedValue(false) },
      menu: { getUpcomingSessions, getLearningProgress, ...menu },
    });
    return {
      gateway,
      getUpcomingSessions,
      getLearningProgress,
      admitOutbound: outboundService.admitOutbound as jest.Mock,
    };
  };

  it('does not fetch or render the menu when the learner is limited', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway, getUpcomingSessions, admitOutbound } = buildDenied({});

    await gateway.onMenuUpcomingSessions([interaction(editReply)]);

    // The upstream fetch is the expensive part; a denied press must not pay it.
    expect(admitOutbound).toHaveBeenCalledWith('discord-user-1', 143, 1);
    expect(getUpcomingSessions).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0][0].content).toContain('tạm hoãn');
  });

  it('leaves the button message untouched on a denial so the learner can retry', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const deferReply = jest.fn().mockResolvedValue(undefined);
    const deferUpdate = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({
      outbound: { admitOutbound: jest.fn().mockResolvedValue(false) },
    });

    await gateway.onMenuUpcomingSessions([
      {
        user: { id: 'discord-user-1' },
        isButton: () => true,
        deferReply,
        deferUpdate,
        editReply,
      } as never,
    ]);

    // deferReply posts a new message; deferUpdate would have edited the pressed
    // message in place. Nothing was mutated, so that message must survive intact.
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(deferUpdate).not.toHaveBeenCalled();
  });

  it('gates the learning-progress menu on the same rule', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway, getLearningProgress, admitOutbound } = buildDenied({});

    await gateway.onMenuLearningProgress([interaction(editReply)]);

    expect(admitOutbound).toHaveBeenCalledWith('discord-user-1', 143, 1);
    expect(getLearningProgress).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0][0].content).toContain('tạm hoãn');
  });

  it('admits with the canonical user id before fetching the menu', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    const { gateway, outboundService } = buildGateway({
      outbound: {
        admitOutbound: jest.fn().mockImplementation(async () => {
          order.push('admit');
          return true;
        }),
      },
      accountLink: { findUserIdByDiscordId: jest.fn().mockResolvedValue(77) },
      menu: {
        getUpcomingSessions: jest.fn().mockImplementation(async () => {
          order.push('fetch');
          return 'upcoming';
        }),
      },
    });

    await gateway.onMenuUpcomingSessions([interaction(editReply)]);

    expect(order).toEqual(['admit', 'fetch']);
    expect(outboundService.admitOutbound as jest.Mock).toHaveBeenCalledWith(
      'discord-user-1',
      77,
      1,
    );
    expect(editReply.mock.calls[0][0].content).toBe('upcoming');
  });

  it('keeps the menu failure message on the error branch', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({
      menu: {
        getUpcomingSessions: jest
          .fn()
          .mockRejectedValue(new Error('WISPACE down')),
      },
    });

    await gateway.onMenuUpcomingSessions([interaction(editReply)]);

    expect(editReply.mock.calls[0][0].content).toBe(
      CHAT_FAILURE_FALLBACK_MESSAGE,
    );
  });
});

describe('DiscordChatGateway reschedule confirmation delivery (#1483)', () => {
  const token = '11111111-1111-4111-8111-111111111111';
  const confirmedResult = {
    confirmed: true as const,
    scheduledTimeLabel: '20/09 lúc 19:00',
  };

  const build = (
    sendText: jest.Mock,
    confirmResult: unknown = confirmedResult,
  ) => {
    const recordConfirmationDelivery = jest.fn().mockResolvedValue(undefined);
    const confirm = jest.fn().mockResolvedValue(confirmResult);
    const { gateway } = buildGateway({
      outbound: { sendText },
      accountLink: {
        findCurrentIdentity: jest
          .fn()
          .mockResolvedValue({ userId: 42, mappingVersion: '1:2026-09-29' }),
      },
      reschedule: { confirm, recordConfirmationDelivery },
    });
    return { gateway, recordConfirmationDelivery, confirm };
  };

  const interaction = (editReply: jest.Mock, action = 'reschedule_confirm') =>
    ({
      user: { id: 'discord-user-1' },
      customId: `${action}:${token}`,
      isButton: () => true,
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply,
    }) as never;

  it('records delivery when the confirmation edit lands', async () => {
    const sendText = jest.fn().mockResolvedValue('sent');
    const { gateway, recordConfirmationDelivery } = build(sendText);

    await gateway.onDynamicRescheduleAction([
      interaction(jest.fn().mockResolvedValue(undefined)),
    ]);

    expect(sendText).not.toHaveBeenCalled();
    expect(recordConfirmationDelivery).toHaveBeenCalledWith(
      'discord-user-1',
      token,
      'sent',
    );
  });

  it('falls back to a new message when the edit fails, and records its outcome', async () => {
    const sendText = jest.fn().mockResolvedValue('rate_limited');
    const { gateway, recordConfirmationDelivery } = build(sendText);

    await gateway.onDynamicRescheduleAction([
      interaction(
        jest.fn().mockRejectedValue(new Error('Unknown interaction')),
      ),
    ]);

    // Discord has no durable inbox to replay this from, so the only chance to
    // reach the learner is a fresh message.
    expect(sendText).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('20/09 lúc 19:00'),
      { userId: 42 },
    );
    expect(recordConfirmationDelivery).toHaveBeenCalledWith(
      'discord-user-1',
      token,
      'rate_limited',
    );
  });

  it('says nothing when the write outcome is unknown', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({
      accountLink: {
        findCurrentIdentity: jest
          .fn()
          .mockResolvedValue({ userId: 42, mappingVersion: '1:2026-09-29' }),
      },
      reschedule: {
        confirm: jest
          .fn()
          .mockResolvedValue({ confirmed: false, unknownOutcome: true }),
      },
    });

    await gateway.onDynamicRescheduleAction([interaction(editReply)]);

    // A failure message here would read as "the change did not happen" when it
    // may well have.
    expect(editReply).not.toHaveBeenCalled();
  });
});

describe('DiscordChatGateway reschedule confirmation admission (#1494)', () => {
  const token = '22222222-2222-4222-8222-222222222222';

  const linkedIdentity = {
    userId: 42,
    mappingVersion: '1:2026-09-29',
  };

  const buildLimited = () => {
    const confirm = jest.fn();
    const cancel = jest.fn();
    const sendText = jest.fn();
    const recordConfirmationDelivery = jest.fn().mockResolvedValue(undefined);
    const { gateway, outboundService } = buildGateway({
      outbound: {
        admitOutbound: jest.fn().mockResolvedValue(false),
        sendText,
      },
      accountLink: {
        findCurrentIdentity: jest.fn().mockResolvedValue(linkedIdentity),
      },
      reschedule: { confirm, cancel, recordConfirmationDelivery },
    });
    return {
      gateway,
      confirm,
      cancel,
      sendText,
      recordConfirmationDelivery,
      admitOutbound: outboundService.admitOutbound as jest.Mock,
    };
  };

  const interaction = (editReply: jest.Mock, action = 'reschedule_confirm') =>
    ({
      user: { id: 'discord-user-1' },
      customId: `${action}:${token}`,
      isButton: () => true,
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply,
    }) as never;

  it('refuses the confirm before the calendar write when the learner is limited', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway, confirm, recordConfirmationDelivery, admitOutbound } =
      buildLimited();

    await gateway.onDynamicRescheduleAction([interaction(editReply)]);

    // Same bucket identity as every other Discord outbound path.
    expect(admitOutbound).toHaveBeenCalledWith('discord-user-1', 42, 1);
    // Admission precedes the mutation: nothing is written for a denied turn.
    expect(confirm).not.toHaveBeenCalled();
    // Silence would read as "the change went through but broke".
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0][0].content).toContain('chưa thay đổi');
    // No mutation means no attempt record exists to record against.
    expect(recordConfirmationDelivery).not.toHaveBeenCalled();
  });

  it('refuses the cancel without touching the staged proposal', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway, cancel, recordConfirmationDelivery, admitOutbound } =
      buildLimited();

    await gateway.onDynamicRescheduleAction([
      interaction(editReply, 'reschedule_cancel'),
    ]);

    // Cancel reads the identity too, otherwise this learner draws from a
    // second bucket just by pressing the other button.
    expect(admitOutbound).toHaveBeenCalledWith('discord-user-1', 42, 1);
    expect(cancel).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0][0].content).toContain('chưa thay đổi');
    expect(recordConfirmationDelivery).not.toHaveBeenCalled();
  });

  it('charges the refusal one admission and echoes no request text', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const { gateway, admitOutbound, sendText } = buildLimited();

    await gateway.onDynamicRescheduleAction([interaction(editReply)]);

    expect(admitOutbound).toHaveBeenCalledTimes(1);
    // One edit is the whole answer; a DM fallback here would be a second
    // delivery attempt for a refusal that already landed.
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    const content = editReply.mock.calls[0][0].content as string;
    expect(content).not.toContain(token);
    expect(content).not.toContain('discord-user-1');
  });

  it('deferUpdate precedes admission so the Redis call cannot burn the 3s token', async () => {
    const order: string[] = [];
    const { gateway } = buildGateway({
      outbound: {
        admitOutbound: jest.fn().mockImplementation(async () => {
          order.push('admit');
          return false;
        }),
      },
      accountLink: {
        findCurrentIdentity: jest.fn().mockResolvedValue(linkedIdentity),
      },
      reschedule: { confirm: jest.fn() },
    });
    const interaction = {
      user: { id: 'discord-user-1' },
      customId: `reschedule_confirm:${token}`,
      isButton: () => true,
      deferUpdate: jest.fn().mockImplementation(async () => {
        order.push('defer');
      }),
      editReply: jest.fn().mockResolvedValue(undefined),
    } as never;

    await gateway.onDynamicRescheduleAction([interaction]);

    expect(order).toEqual(['defer', 'admit']);
  });

  it('admits, then confirms, then records — admission is consulted before the write', async () => {
    const order: string[] = [];
    const confirm = jest.fn().mockImplementation(async () => {
      order.push('confirm');
      return {
        confirmed: true as const,
        scheduledTimeLabel: '20/09 lúc 19:00',
      };
    });
    const recordConfirmationDelivery = jest
      .fn()
      .mockImplementation(async () => {
        order.push('record');
      });
    const { gateway } = buildGateway({
      outbound: {
        admitOutbound: jest.fn().mockImplementation(async () => {
          order.push('admit');
          return true;
        }),
      },
      accountLink: {
        findCurrentIdentity: jest.fn().mockResolvedValue(linkedIdentity),
      },
      reschedule: { confirm, recordConfirmationDelivery },
    });

    await gateway.onDynamicRescheduleAction([
      interaction(jest.fn().mockResolvedValue(undefined)),
    ]);

    expect(order).toEqual(['admit', 'confirm', 'record']);
    expect(recordConfirmationDelivery).toHaveBeenCalledWith(
      'discord-user-1',
      token,
      'sent',
    );
  });

  it('charges the edit-failure fallback to the same bucket as the admission', async () => {
    const sendText = jest.fn().mockResolvedValue('not_sent');
    const recordConfirmationDelivery = jest.fn().mockResolvedValue(undefined);
    const { gateway } = buildGateway({
      outbound: { sendText },
      accountLink: {
        findCurrentIdentity: jest.fn().mockResolvedValue(linkedIdentity),
      },
      reschedule: {
        confirm: jest.fn().mockResolvedValue({
          confirmed: true as const,
          scheduledTimeLabel: '20/09 lúc 19:00',
        }),
        recordConfirmationDelivery,
      },
    });

    await gateway.onDynamicRescheduleAction([
      interaction(
        jest.fn().mockRejectedValue(new Error('Unknown interaction')),
      ),
    ]);

    // Without the userId the fallback lands in the external-id bucket and the
    // same turn draws from two budgets.
    expect(sendText).toHaveBeenCalledWith(
      'discord-user-1',
      expect.any(String),
      {
        userId: 42,
      },
    );
    expect(recordConfirmationDelivery).toHaveBeenCalledWith(
      'discord-user-1',
      token,
      'not_sent',
    );
  });

  it('degrades to the failure message when the identity lookup fails', async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const confirm = jest.fn();
    const { gateway } = buildGateway({
      accountLink: {
        findCurrentIdentity: jest.fn().mockRejectedValue(new Error('DB blip')),
      },
      reschedule: { confirm },
    });

    await gateway.onDynamicRescheduleAction([interaction(editReply)]);

    // A lookup failure must not strand the learner on a spinner.
    expect(confirm).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0][0].content).toBe(
      CHAT_FAILURE_FALLBACK_MESSAGE,
    );
  });
});

describe('DiscordChatGateway intent fast-path', () => {
  it.each(['chao ban', 'ban la ai', 'hi', 'giới thiệu', 'bạn là ai vậy'])(
    'replies directly to no-diacritic intent "%s" without queueing',
    async (text) => {
      const { gateway, outboundService, chatQueueService } = buildGateway({});
      const message = {
        author: {
          bot: false,
          id: 'discord-user-1',
          displayName: 'Test User',
        },
        channel: {
          type: ChannelType.DM,
          sendTyping: jest.fn().mockResolvedValue(undefined),
        },
        content: text,
        attachments: { size: 0 },
        stickers: { size: 0 },
        embeds: [],
        mentions: { users: new Map() },
        client: { user: null },
      };

      await gateway.onMessageCreate([message] as never);

      expect(outboundService.sendMenuButtons).toHaveBeenCalledWith(
        'discord-user-1',
        expect.stringContaining('WISPACE'),
      );
      expect(chatQueueService.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    'Hi, cho mình hỏi cách viết Task 2 với',
    'Chào bạn, mình muốn xem tiến độ học',
    'Hello, can you check my essay please?',
    'Xin chào, lịch học tuần này thế nào ạ',
    'Hey bạn, band mục tiêu của mình là bao nhiêu',
    'chào bạn mình bị áp lực thi quá',
    'giới thiệu về cấu trúc Task 1 giúp mình',
    'giới thiệu bài mẫu band 7 cho mình',
    'bạn là ai, giúp mình kiểm tra bài viết',
    'Cho mình hỏi cách viết Task 2',
  ])('queues content after standalone wording: "%s"', async (text) => {
    const { gateway, outboundService, chatQueueService } = buildGateway({});
    const message = {
      id: 'message-941',
      author: {
        bot: false,
        id: 'discord-user-1',
        displayName: 'Test User',
      },
      channel: {
        type: ChannelType.DM,
        sendTyping: jest.fn().mockResolvedValue(undefined),
      },
      content: text,
      attachments: { size: 0 },
      stickers: { size: 0 },
      embeds: [],
      mentions: { users: new Map() },
      client: { user: null },
    };

    await gateway.onMessageCreate([message] as never);

    expect(outboundService.sendMenuButtons).not.toHaveBeenCalled();
    expect(chatQueueService.enqueue).toHaveBeenCalledWith(
      'discord-user-1',
      text,
      { userId: 143, isServerChannel: false },
      'discord:message-941',
    );
  });
});
