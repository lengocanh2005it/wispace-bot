import { Injectable, Logger } from '@nestjs/common';
import {
  GREETING_INTRO,
  buildGreetingMessage,
  buildSelfIntroMessage,
  buildUnsupportedMessageTypeReply,
} from '@wispace/bot-common/messages';
import {
  errorMessage,
  maskExternalId,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
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
import { readPendingOrganicSkipMs } from '@discord/shared/config/discord-link.config';
import { DISCORD_LINK_VERIFY_RECORD_REPOSITORY } from '@discord/modules/account-link/domain/ports/discord-link-verify-record.repository.port';
import type { DiscordLinkVerifyRecordRepositoryPort } from '@discord/modules/account-link/domain/ports/discord-link-verify-record.repository.port';
import { DiscordWelcomeService } from '@discord/modules/account-link/application/services/discord-welcome.service';
import { Inject } from '@nestjs/common';
import { PlatformChatRateLimitService } from '@wispace/chat-metering';
import { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordMenuService } from '../../application/services/discord-menu.service';
import { WispaceApiError } from '@wispace/wispace-client';
import {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  IntentDetector,
} from '@wispace/llm-agent';

function formatError(error: unknown): string {
  if (error instanceof WispaceApiError) {
    return `WispaceApiError: statusCode=${error.statusCode} endpoint=${error.endpoint} externalId=${maskExternalId(error.externalId)} - ${errorMessage(error)}`;
  }
  return errorMessage(error);
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
    private readonly chatQueueService: PlatformChatQueueService,
    @Inject(DISCORD_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: DiscordLinkVerifyRecordRepositoryPort,
    private readonly welcomeService: DiscordWelcomeService,
  ) {}

  @Once('clientReady')
  onReady(@Context() [client]: ContextOf<'clientReady'>) {
    this.logger.log(`Discord bot online as ${client.user.tag}`);
  }

  @On('guildMemberAdd')
  async onGuildMemberAdd(@Context() [member]: ContextOf<'guildMemberAdd'>) {
    const displayName = member.displayName;
    const discordUserId = member.id;

    let isLinked: boolean | undefined;
    let dmOutcome = 'skipped';

    try {
      // Linking already happened at OAuth callback time (independent of guild
      // membership) — here we only deliver the welcome DM that could not be
      // sent earlier because Discord DMs require a shared guild.
      const wispaceUserId =
        await this.accountLinkService.findUserIdByDiscordId(discordUserId);
      isLinked = wispaceUserId !== undefined;
    } catch (error) {
      this.logger.error(
        `guildMemberAdd mapping lookup failed discordUserId=${maskExternalId(
          discordUserId,
        )}: ${formatError(error)}`,
      );
    }

    // Public welcome in server channel (if DISCORD_WELCOME_CHANNEL_ID is set).
    // Isolated try/catch: a channel-welcome failure must not suppress the DM
    // attempt (#234).
    const welcomeChannelId = this.configService.get<string>(
      'DISCORD_WELCOME_CHANNEL_ID',
    );
    if (welcomeChannelId) {
      try {
        const serverMsg = isLinked
          ? `Chào mừng <@${discordUserId}> đến với server WISPACE! 👋\n\n` +
            `Tài khoản WISPACE đã được liên kết. ${GREETING_INTRO} 🎓`
          : `Chào mừng <@${discordUserId}> đến với server WISPACE! 👋\n\n` +
            `${GREETING_INTRO} 🎓\n\n` +
            `Để dùng đầy đủ tính năng, bạn cần liên kết tài khoản WISPACE với Discord trước nhé. Vào WISPACE và chọn "Kết nối Discord" để bắt đầu!`;
        await this.outboundService.sendToChannel(welcomeChannelId, serverMsg);
      } catch (error) {
        this.logger.error(
          `guildMemberAdd channel welcome failed channelId=${maskExternalId(
            welcomeChannelId,
          )}: ${formatError(error)}`,
        );
      }
    }

    // Private DM — already sent at callback when the user was in the guild;
    // only send here for users who linked before joining or joined organically.
    // The shared `discord_welcome_records` dedupe state (#231) prevents
    // re-joins and the join-during-callback race (#137 items 2+4) from
    // sending a second DM.
    try {
      if (isLinked) {
        dmOutcome = await this.welcomeService.welcomeIfDue(
          discordUserId,
          displayName,
        );
      } else {
        // Join-during-callback race: the mapping may not be committed yet, but
        // a fresh verify intent means the callback is in flight and will send
        // the linked welcome itself — skip the organic one. Stale intents
        // (callback failed) still get the organic welcome.
        const pending =
          await this.verifyRecordService.findPending(discordUserId);
        const pendingIsFresh =
          pending !== undefined &&
          Date.now() - pending.verifiedAt.getTime() <
            readPendingOrganicSkipMs(this.configService);
        if (pendingIsFresh) {
          this.logger.log(
            `Skipping organic welcome for discordUserId=${maskExternalId(
              discordUserId,
            )} — link callback in flight`,
          );
        } else {
          dmOutcome = await this.welcomeService.sendOrganicWelcomeIfDue(
            discordUserId,
            displayName,
          );
        }
      }
    } catch (error) {
      dmOutcome = 'error';
      this.logger.error(
        `guildMemberAdd DM delivery failed discordUserId=${maskExternalId(
          discordUserId,
        )}: ${formatError(error)}`,
      );
    }

    this.logger.log(
      `Welcome attempt discordUserId=${maskExternalId(
        discordUserId,
      )} displayName=${maskExternalId(
        sanitizeLogValue(displayName, 64),
      )} linked=${isLinked ?? 'unknown'} channelId=${
        welcomeChannelId ?? 'none'
      } dm=${dmOutcome}`,
    );
  }

  @On('messageCreate')
  async onMessageCreate(@Context() [message]: ContextOf<'messageCreate'>) {
    if (message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const isServerChannel = !isDM;
    const discordUserId = message.author.id;

    // Detect @mention → strip mention tags, use neutral trigger if bare ping
    const botUser = message.client.user;
    const isMentioned =
      botUser != null && message.mentions.users.has(botUser.id);

    // In server channels: only respond when @mentioned to avoid replying to everyone
    if (isServerChannel && !isMentioned) return;

    const userText = message.content.trim();
    if (!userText) {
      const hasNonTextContent =
        message.attachments.size > 0 ||
        message.stickers.size > 0 ||
        message.embeds.length > 0;
      if (!hasNonTextContent) return;

      const fallback = buildUnsupportedMessageTypeReply();
      if (isServerChannel) {
        await message.reply(fallback);
      } else {
        await this.outboundService.sendMenuButtons(discordUserId, fallback);
      }
      return;
    }

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
        message.member?.displayName ?? message.author.displayName;
      const reply = buildGreetingMessage(displayName);
      if (isServerChannel) {
        await message.reply(reply);
      } else {
        await this.outboundService.sendMenuButtons(discordUserId, reply);
      }
      return;
    }
    if (intent.intent === 'self_intro') {
      const reply = buildSelfIntroMessage();
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

      await this.chatQueueService.enqueue(
        discordUserId,
        resolvedText,
        { userId, isServerChannel },
        `discord:${message.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Chat enqueue failed for discordUserId=${maskExternalId(
          discordUserId,
        )}`,
        formatError(error),
      );
      if (isServerChannel) {
        await message.reply(CHAT_FAILURE_FALLBACK_MESSAGE);
      } else {
        await this.outboundService.sendText(
          discordUserId,
          CHAT_FAILURE_FALLBACK_MESSAGE,
        );
      }
    }
  }

  @Button(RESCHEDULE_CONFIRM_CUSTOM_ID)
  async onRescheduleConfirm(@Context() [interaction]: ButtonContext) {
    const discordUserId = interaction.user.id;
    await interaction.deferUpdate();

    let content: string;
    try {
      const userId =
        await this.accountLinkService.findUserIdByDiscordId(discordUserId);
      const result = await this.rescheduleConfirmationService.confirm(
        discordUserId,
        userId,
      );
      content = result.confirmed
        ? `Đã dời lịch sang ${result.scheduledTimeLabel}.`
        : result.message;
    } catch (error) {
      this.logger.error(
        `Reschedule confirm failed for discordUserId=${maskExternalId(
          discordUserId,
        )}`,
        formatError(error),
      );
      content = CHAT_FAILURE_FALLBACK_MESSAGE;
    }

    await interaction.editReply({ content, components: [] });
  }

  @Button(RESCHEDULE_CANCEL_CUSTOM_ID)
  async onRescheduleCancel(@Context() [interaction]: ButtonContext) {
    const discordUserId = interaction.user.id;
    await interaction.deferUpdate();

    let content: string;
    try {
      content = await this.rescheduleConfirmationService.cancel(discordUserId);
    } catch (error) {
      this.logger.error(
        `Reschedule cancel failed for discordUserId=${maskExternalId(
          discordUserId,
        )}`,
        formatError(error),
      );
      content = CHAT_FAILURE_FALLBACK_MESSAGE;
    }

    await interaction.editReply({ content, components: [] });
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
      await interaction.editReply(CHAT_FAILURE_FALLBACK_MESSAGE);
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
      await interaction.editReply(CHAT_FAILURE_FALLBACK_MESSAGE);
    }
  }
}
