import type { MessageMentionOptions } from 'discord.js';

export type DiscordOutboundActionKind = 'everyone' | 'here' | 'role' | 'user';

export type DiscordOutboundNeutralized = Record<
  DiscordOutboundActionKind,
  number
>;

export interface DiscordOutboundPreparation {
  content: string;
  allowedMentions: MessageMentionOptions;
  neutralized: DiscordOutboundNeutralized;
}

const DISCORD_ACTION_PATTERN =
  /(?<![\p{L}\p{N}_])@everyone(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])@here(?![\p{L}\p{N}_])|<@&\d+>|<@!?\d+>/giu;
const DISCORD_USER_ID_PATTERN = /^\d+$/;

function emptyNeutralizedCounts(): DiscordOutboundNeutralized {
  return { everyone: 0, here: 0, role: 0, user: 0 };
}

export function prepareDiscordOutbound(
  text: string,
  allowedUserIds: readonly string[] = [],
): DiscordOutboundPreparation {
  const trustedUserIds = [
    ...new Set(allowedUserIds.filter((id) => DISCORD_USER_ID_PATTERN.test(id))),
  ];
  const trustedUsers = new Set(trustedUserIds);
  const neutralized = emptyNeutralizedCounts();

  const content = text.replace(DISCORD_ACTION_PATTERN, (token) => {
    if (token.toLowerCase().startsWith('@everyone')) {
      neutralized.everyone += 1;
      return '[mọi người]';
    }
    if (token.toLowerCase().startsWith('@here')) {
      neutralized.here += 1;
      return '[kênh này]';
    }
    if (token.startsWith('<@&')) {
      neutralized.role += 1;
      return '[vai trò]';
    }

    const userId = token.slice(2, -1).replace(/^!/, '');
    if (trustedUsers.has(userId)) {
      return token;
    }

    neutralized.user += 1;
    return '[người dùng]';
  });

  return {
    content,
    allowedMentions: {
      parse: [],
      roles: [],
      users: trustedUserIds,
      repliedUser: false,
    },
    neutralized,
  };
}
