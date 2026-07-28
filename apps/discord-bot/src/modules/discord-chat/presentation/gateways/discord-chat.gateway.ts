import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from 'discord.js';
import { Button, Context, On, Once } from 'necord';
import type { ButtonContext, ContextOf } from 'necord';
import { DiscordAgentService } from '../../application/agent/discord-agent.service';
import { DiscordChatQueueService } from '../../application/services/discord-chat-queue.service';
import { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import { DiscordRescheduleConfirmationService } from '../../application/services/discord-reschedule-confirmation.service';
import {
  RESCHEDULE_CANCEL_CUSTOM_ID,
  RESCHEDULE_CONFIRM_CUSTOM_ID,
} from '../../application/constants/discord-reschedule.constants';
import {
  MENU_LEARNING_PROGRESS_CUSTOM_ID,
  MENU_UPCOMING_SESSIONS_CUSTOM_ID,
} from '../../application/constants/discord-menu.constants';
import { DiscordChatRateLimitService } from '../../../chat-metering/application/services/discord-chat-rate-limit.service';
import { DiscordChatHistoryService } from '../../application/services/discord-chat-history.service';
import { DiscordAccountLinkService } from '../../../account-link/application/services/discord-account-link.service';
import { DiscordMenuService } from '../../application/services/discord-menu.service';
import { DiscordPendingJoinService } from '../../../account-link/application/services/discord-pending-join.service';
import { buildDiscordLinkWelcomeMessage } from '../../../account-link/application/messages/account-link.messages';
import { WispaceApiError } from '@wispace/wispace-client';
import { isGreetingOnly } from '@wispace/llm-agent';

const FALLBACK_ERROR_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

const FALLBACK_GREETING_MESSAGE =
  'Chào bạn! Mình là trợ lý học tập WISPACE. Hiện mình đang gặp chút trục trặc, bạn thử nhắn lại sau ít phút để mình hỗ trợ nhé.';

function formatError(error: unknown): string {
  if (error instanceof WispaceApiError) {
    return (
      `WispaceApiError: statusCode=${error.statusCode} endpoint=${error.endpoint} externalId=${error.externalId}\n` +
      (error.stack ?? error.message)
    );
  }
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

@Injectable()
export class DiscordChatGateway {
  private readonly logger = new Logger(DiscordChatGateway.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: DiscordAgentService,
    private readonly outboundService: DiscordOutboundService,
    private readonly rateLimitService: DiscordChatRateLimitService,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly rescheduleConfirmationService: DiscordRescheduleConfirmationService,
    private readonly menuService: DiscordMenuService,
    private readonly chatHistoryService: DiscordChatHistoryService,
    private readonly pendingJoinService: DiscordPendingJoinService,
    private readonly chatQueueService: DiscordChatQueueService,
  ) {}

  @Once('clientReady')
  onReady(@Context() [client]: ContextOf<'clientReady'>) {
    this.logger.log(`Discord bot online as ${client.user.tag}`);
  }

  @On('guildMemberAdd')
  async onGuildMemberAdd(@Context() [member]: ContextOf<'guildMemberAdd'>) {
    const displayName = member.displayName;
    const discordUserId = member.id;

    // Auto-complete pending account link if user came through OAuth flow
    const pending = this.pendingJoinService.findByDiscordUserId(discordUserId);
    if (pending) {
      try {
        await this.accountLinkService.upsertLink(
          pending.entry.wispaceUserId,
          discordUserId,
        );
        const dmChannelId = await this.outboundService.sendTextAndGetChannelId(
          discordUserId,
          buildDiscordLinkWelcomeMessage(pending.entry.discordUsername),
        );
        this.pendingJoinService.markCompleted(pending.token, dmChannelId);
        this.logger.log(
          `Auto-completed account link for discordUserId=${discordUserId} wispaceUserId=${pending.entry.wispaceUserId}`,
        );
      } catch (error) {
        this.logger.error(
          `Auto-complete link failed for discordUserId=${discordUserId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Public welcome in server channel (if DISCORD_WELCOME_CHANNEL_ID is set)
    const welcomeChannelId = this.configService.get<string>(
      'DISCORD_WELCOME_CHANNEL_ID',
    );
    if (welcomeChannelId) {
      const serverMsg = pending
        ? `Chào mừng <@${discordUserId}> đến với server WISPACE! 👋\n\n` +
          `Tài khoản WISPACE đã được liên kết. Hỏi mình bất cứ điều gì về lịch học, tiến độ IELTS hoặc mục tiêu band nhé 🎓`
        : `Chào mừng <@${discordUserId}> đến với server WISPACE! 👋\n\n` +
          `Mình là trợ lý AI của WISPACE — mình có thể giúp bạn xem lịch học, tiến độ IELTS Writing và trả lời các câu hỏi luyện thi.\n\n` +
          `Để dùng đầy đủ tính năng, bạn cần liên kết tài khoản WISPACE với Discord trước nhé. Vào WISPACE và chọn "Kết nối Discord" để bắt đầu! 🎓`;
      await this.outboundService.sendToChannel(welcomeChannelId, serverMsg);
    }

    // Private DM — already sent above when link completed; only send for organic joins
    if (!pending) {
      const dmMsg =
        `Chào ${displayName}! Mình là trợ lý WISPACE. ` +
        `Bạn có thể hỏi về tiến độ học, lịch học sắp tới, hoặc mục tiêu band — cứ nhắn tự nhiên nhé 🎓`;
      await this.outboundService.sendText(discordUserId, dmMsg);
    }

    this.logger.log(
      `Welcome sent to new member discordUserId=${discordUserId} displayName=${displayName} channelId=${welcomeChannelId ?? 'none'}`,
    );
  }

  @On('messageCreate')
  async onMessageCreate(@Context() [message]: ContextOf<'messageCreate'>) {
    if (message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isServerChannel = !isDM;

    const userText = message.content.trim();
    if (!userText) return;

    const discordUserId = message.author.id;

    // Detect @mention → strip mention tags, use neutral trigger if bare ping
    const botUser = message.client.user;
    const isMentioned =
      botUser != null && message.mentions.users.has(botUser.id);

    // In server channels: only respond when @mentioned to avoid replying to everyone
    if (isServerChannel && !isMentioned) return;

    if (isDM && userText.toLowerCase() === 'menu') {
      await this.outboundService.sendMenuButtons(discordUserId);
      return;
    }

    let resolvedText = userText;
    if (isMentioned) {
      resolvedText = userText.replace(/<@!?\d+>/g, '').trim();
      if (!resolvedText) {
        resolvedText = 'Bạn gọi mình?';
      }
    }

    try {
      await message.channel.sendTyping();
      const userId =
        await this.accountLinkService.findUserIdByDiscordId(discordUserId);

      this.chatQueueService.enqueue(
        discordUserId,
        resolvedText,
        { userId, isServerChannel },
        `discord:${message.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Chat enqueue failed for discordUserId=${discordUserId}`,
        formatError(error),
      );
      const fallback = isGreetingOnly(resolvedText)
        ? FALLBACK_GREETING_MESSAGE
        : FALLBACK_ERROR_MESSAGE;
      if (isServerChannel) {
        await message.reply(fallback);
      } else {
        await this.outboundService.sendText(discordUserId, fallback);
      }
    }
  }

  @Button(RESCHEDULE_CONFIRM_CUSTOM_ID)
  async onRescheduleConfirm(@Context() [interaction]: ButtonContext) {
    const discordUserId = interaction.user.id;
    const userId =
      await this.accountLinkService.findUserIdByDiscordId(discordUserId);
    const result = await this.rescheduleConfirmationService.confirm(
      discordUserId,
      userId,
    );

    await interaction.update({
      content: result.confirmed
        ? `Đã dời lịch sang ${result.scheduledTimeLabel}.`
        : result.message,
      components: [],
    });
  }

  @Button(RESCHEDULE_CANCEL_CUSTOM_ID)
  async onRescheduleCancel(@Context() [interaction]: ButtonContext) {
    const discordUserId = interaction.user.id;
    const message = this.rescheduleConfirmationService.cancel(discordUserId);

    await interaction.update({ content: message, components: [] });
  }

  @Button(MENU_UPCOMING_SESSIONS_CUSTOM_ID)
  async onMenuUpcomingSessions(@Context() [interaction]: ButtonContext) {
    await interaction.deferReply();
    try {
      const discordUserId = interaction.user.id;
      const userId =
        await this.accountLinkService.findUserIdByDiscordId(discordUserId);
      const text = await this.menuService.getUpcomingSessions(
        discordUserId,
        userId,
      );
      await interaction.editReply(text);
    } catch (error) {
      this.logger.error(`menu_upcoming failed`, formatError(error));
      await interaction.editReply(FALLBACK_ERROR_MESSAGE);
    }
  }

  @Button(MENU_LEARNING_PROGRESS_CUSTOM_ID)
  async onMenuLearningProgress(@Context() [interaction]: ButtonContext) {
    await interaction.deferReply();
    try {
      const discordUserId = interaction.user.id;
      const userId =
        await this.accountLinkService.findUserIdByDiscordId(discordUserId);
      const text = await this.menuService.getLearningProgress(
        discordUserId,
        userId,
      );
      await interaction.editReply(text);
    } catch (error) {
      this.logger.error(`menu_progress failed`, formatError(error));
      await interaction.editReply(FALLBACK_ERROR_MESSAGE);
    }
  }
}
