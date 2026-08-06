import { ConfigService } from '@nestjs/config';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';

export function readMessengerBubbleLimits(configService: ConfigService): {
  maxBubbles: number;
  maxCharsPerBubble: number;
} {
  return {
    maxBubbles: readEnvPositiveInt(configService, 'CHAT_MAX_BUBBLES', 4),
    maxCharsPerBubble: readEnvPositiveInt(
      configService,
      'CHAT_BUBBLE_MAX_CHARS',
      640,
    ),
  };
}
