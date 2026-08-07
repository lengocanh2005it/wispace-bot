import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from 'discord.js';
import { Button, Context, On, Once } from 'necord';
import type { ButtonContext, ContextOf } from 'necord';
import {
  PlatformAgentService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import { DiscordOutboundService } from '../../application/services/discord-outbound.service';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import {
  RESCHEDULE_CANCEL_CUSTOM_ID,
  RESCHEDULE_CONFIRM_CUSTOM_ID,
} from '../../application/constants/discord-reschedule.constants';
import {
  MENU_LEARNING_PROGRESS_CUSTOM_ID,
  MENU_UPCOMING_SESSIONS_CUSTOM_ID,
} from '../../application/constants/discord-menu.constants';
import { PlatformChatRateLimitService } from '@wispace/chat-metering';
import { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordMenuService } from '../../application/services/discord-menu.service';
import { DiscordPendingJoinService } from '@discord/modules/account-link/application/services/discord-pending-join.service';
import { buildDiscordLinkWelcomeMessage } from '@discord/modules/account-link/application/messages/account-link.messages';
import { WispaceApiError } from '@wispace/wispace-client';
import { IntentDetector } from '@wispace/llm-agent';

const FALLBACK_ERROR_MESSAGE =
  'Xin lỗi, mình gặp sự cố khi xử lý tin nhắn. Bạn thử lại sau ít phút nhé.';

const GREETING_TEMPLATE =
  'Chào {name}! 👋 Mình là trợ lý WISPACE — hỗ trợ bạn học IELTS Writing. Bạn có thể hỏi về lịch học, tiến độ hoặc mục tiêu band nhé!';

const SELF_INTRO_TEMPLATE =
  'Mình là WISPACE Bot — trợ lý AI hỗ trợ học IELTS Writing trên Discord. Mình có thể giúp bạn xem lịch học, tiến độ và mục tiêu band. Gõ "hi" để bắt đầu! 🎓';

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
  private readonly intentDetector = new IntentDetector();

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: PlatformAgentService,
    private readonly outboundService: DiscordOutboundService,
    private readonly rateLimitService: PlatformChatRateLimitService,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly rescheduleConfirmationService: RescheduleConfirmationService<string>,
    private readonly menuService: DiscordMenuService,
    private readonly chatHistoryService: PlatformChatHistoryService,
    private readonly pendingJoinService: DiscordPendingJoinService,
    private readonly chatQueueService: PlatformChatQueueService,
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
        const dmChannelId = await this.outboundService.sendMenuButtons(
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
      await this.outboundService.sendMenuButtons(discordUserId, dmMsg);
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

    // Intent detection: greeting/self-intro → reply directly, skip LLM
    const intent = this.intentDetector.detect(resolvedText);
    if (intent.intent === 'greeting') {
      const displayName =
        message.member?.displayName ?? message.author.displayName ?? 'bạn';
      const reply = GREETING_TEMPLATE.replace('{name}', displayName);
      if (isServerChannel) {
        await message.reply(reply);
      } else {
        await this.outboundService.sendMenuButtons(discordUserId, reply);
      }
      return;
    }
    if (intent.intent === 'self_intro') {
      const reply = SELF_INTRO_TEMPLATE;
      if (isServerChannel) {
        await message.reply(reply);
      } else {
        await this.outboundService.sendMenuButtons(discordUserId, reply);
      }
      return;
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
      if (isServerChannel) {
        await message.reply(FALLBACK_ERROR_MESSAGE);
      } else {
        await this.outboundService.sendText(
          discordUserId,
          FALLBACK_ERROR_MESSAGE,
        );
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
