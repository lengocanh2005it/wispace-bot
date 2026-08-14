/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */

import { ConfigService } from '@nestjs/config';
import type { ButtonContext } from 'necord';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from '@wispace/reschedule-confirm';
import { CHAT_FAILURE_FALLBACK_MESSAGE } from '@wispace/llm-agent';
import { DiscordChatGateway } from './discord-chat.gateway';
import { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordMenuService } from '../../application/services/discord-menu.service';
import { PlatformAgentService } from '@wispace/chat-agent';
import {
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import { PlatformChatRateLimitService } from '@wispace/chat-metering';

function createInteraction(events: string[], id = 'discord-1', userId = id) {
  return {
    user: { id: userId },
    deferUpdate: jest.fn(() => {
      events.push(`${id}:ack`);
      return Promise.resolve();
    }),
    editReply: jest.fn(() => {
      events.push(`${id}:edit`);
      return Promise.resolve();
    }),
  };
}

function createGateway(
  accountLinkService: { findUserIdByDiscordId: jest.Mock } = {
    findUserIdByDiscordId: jest.fn().mockResolvedValue(42),
  },
  rescheduleConfirmationService: {
    confirm: jest.Mock;
    cancel: jest.Mock;
  } = {
    confirm: jest.fn(),
    cancel: jest.fn(),
  },
) {
  return new DiscordChatGateway(
    {} as ConfigService,
    {} as PlatformAgentService,
    {} as DiscordOutboundService,
    {} as PlatformChatRateLimitService,
    accountLinkService as unknown as DiscordAccountLinkService,
    rescheduleConfirmationService as unknown as RescheduleConfirmationService<string>,
    {} as DiscordMenuService,
    {} as PlatformChatHistoryService,
    {} as PlatformChatQueueService,
  );
}

describe('DiscordChatGateway reschedule buttons', () => {
  it('acknowledges confirm before account lookup and edits the original once on success', async () => {
    const events: string[] = [];
    const accountLink = {
      findUserIdByDiscordId: jest.fn(() => {
        events.push('lookup');
        return Promise.resolve(42);
      }),
    };
    const reschedule = {
      confirm: jest.fn(() => {
        events.push('confirm');
        return Promise.resolve({
          confirmed: true as const,
          scheduledTimeLabel: '29/07/2026 15:00',
        });
      }),
      cancel: jest.fn(),
    };
    const gateway = createGateway(accountLink, reschedule);
    const interaction = createInteraction(events);

    await gateway.onRescheduleConfirm([
      interaction,
    ] as unknown as ButtonContext);

    expect(events).toEqual([
      'discord-1:ack',
      'lookup',
      'confirm',
      'discord-1:edit',
    ]);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Đã dời lịch sang 29/07/2026 15:00.',
      components: [],
    });
  });

  it('acknowledges cancel before the slow cancel operation and edits once', async () => {
    const events: string[] = [];
    const reschedule = {
      confirm: jest.fn(),
      cancel: jest.fn(() => {
        events.push('cancel');
        return Promise.resolve('Đã hủy yêu cầu đổi lịch.');
      }),
    };
    const gateway = createGateway(undefined, reschedule);
    const interaction = createInteraction(events);

    await gateway.onRescheduleCancel([interaction] as unknown as ButtonContext);

    expect(events).toEqual(['discord-1:ack', 'cancel', 'discord-1:edit']);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: 'Đã hủy yêu cầu đổi lịch.',
      components: [],
    });
  });

  it('acknowledges before a slow account lookup completes', async () => {
    let resolveLookup!: (userId: number) => void;
    const accountLink = {
      findUserIdByDiscordId: jest.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveLookup = resolve;
          }),
      ),
    };
    const reschedule = {
      confirm: jest.fn().mockResolvedValue({
        confirmed: true as const,
        scheduledTimeLabel: '29/07/2026 15:00',
      }),
      cancel: jest.fn(),
    };
    const gateway = createGateway(accountLink, reschedule);
    const interaction = createInteraction([]);

    const click = gateway.onRescheduleConfirm([
      interaction,
    ] as unknown as ButtonContext);
    await Promise.resolve();

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();

    resolveLookup(42);
    await click;
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  it('shows a fallback after acknowledgement when account lookup fails', async () => {
    const events: string[] = [];
    const accountLink = {
      findUserIdByDiscordId: jest.fn(() => {
        events.push('lookup');
        return Promise.reject(new Error('account service down'));
      }),
    };
    const reschedule = {
      confirm: jest.fn(),
      cancel: jest.fn(),
    };
    const gateway = createGateway(accountLink, reschedule);
    const interaction = createInteraction(events);

    await gateway.onRescheduleConfirm([
      interaction,
    ] as unknown as ButtonContext);

    expect(events).toEqual(['discord-1:ack', 'lookup', 'discord-1:edit']);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: CHAT_FAILURE_FALLBACK_MESSAGE,
      components: [],
    });
    expect(reschedule.confirm).not.toHaveBeenCalled();
  });

  it('keeps repeated confirm clicks idempotent while the first reschedule is slow', async () => {
    const events: string[] = [];
    let signalRescheduleStarted!: () => void;
    const rescheduleStarted = new Promise<void>((resolve) => {
      signalRescheduleStarted = resolve;
    });
    let releaseReschedule!: (result: { scheduledTimeLabel: string }) => void;
    const calendar: CalendarPort<string> = {
      listUpcomingEntries: jest
        .fn()
        .mockResolvedValue([
          { calendarId: 7, scheduledTimeLabel: 'Hôm nay 14:00' },
        ]),
    };
    const reschedulePort: ReschedulePort<string> = {
      rescheduleSession: jest.fn(
        () =>
          new Promise((resolve) => {
            signalRescheduleStarted();
            releaseReschedule = resolve;
          }),
      ),
    };
    const service = new RescheduleConfirmationService(calendar, reschedulePort);
    await service.stage({
      externalId: 'discord-1',
      userId: 42,
      calendarId: 7,
      schedulingMode: 'default_next_day_same_time',
    });
    const gateway = createGateway(
      { findUserIdByDiscordId: jest.fn().mockResolvedValue(42) },
      service,
    );
    const first = createInteraction(events, 'first', 'discord-1');
    const second = createInteraction(events, 'second', 'discord-1');

    const firstClick = gateway.onRescheduleConfirm([
      first,
    ] as unknown as ButtonContext);
    const secondClick = gateway.onRescheduleConfirm([
      second,
    ] as unknown as ButtonContext);

    await rescheduleStarted;
    expect(reschedulePort.rescheduleSession).toHaveBeenCalledTimes(1);

    releaseReschedule({ scheduledTimeLabel: 'Ngày mai 14:00' });
    await Promise.all([firstClick, secondClick]);

    expect(reschedulePort.rescheduleSession).toHaveBeenCalledTimes(1);
    expect(first.editReply).toHaveBeenCalledTimes(1);
    expect(second.editReply).toHaveBeenCalledTimes(1);
  });
});
