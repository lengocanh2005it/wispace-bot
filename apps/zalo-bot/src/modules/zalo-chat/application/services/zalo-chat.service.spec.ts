import type { ConfigService } from '@nestjs/config';
import { ZaloChatService } from './zalo-chat.service';
import { ZaloAgentService } from '../agent/zalo-agent.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAccountLinkService } from '../../../zalo-oauth/application/services/zalo-account-link.service';
import type { ZaloChatRateLimitService } from './zalo-chat-rate-limit.service';

function buildConfig(): ConfigService {
  return {
    get: (key: string) =>
      ({
        ZALO_APP_ID: 'app-1',
        ZALO_OAUTH_REDIRECT_URI:
          'https://zalo-bot.example.com/zalo/oauth/callback',
      })[key],
  } as unknown as ConfigService;
}

function buildRateLimitService(): ZaloChatRateLimitService {
  return {
    isEnabled: () => false,
    reserve: jest.fn(),
    markCompleted: jest.fn(),
    refund: jest.fn(),
  } as unknown as ZaloChatRateLimitService;
}

describe('ZaloChatService', () => {
  it('resolves userId, calls the agent, and sends the reply back', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(42);
    const reply = jest.fn().mockResolvedValue({ text: 'Xin chào!' });
    const sendText = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      buildConfig(),
      { reply } as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
      buildRateLimitService(),
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(findUserIdByZaloId).toHaveBeenCalledWith('zalo-1');
    expect(reply).toHaveBeenCalledWith({
      zaloUserId: 'zalo-1',
      userId: 42,
      userText: 'chào bạn',
    });
    expect(sendText).toHaveBeenCalledWith('zalo-1', 'Xin chào!');
  });

  it('falls back to an error message when the agent throws', async () => {
    const findUserIdByZaloId = jest.fn().mockResolvedValue(undefined);
    const reply = jest.fn().mockRejectedValue(new Error('LLM down'));
    const sendText = jest.fn().mockResolvedValue(undefined);

    const service = new ZaloChatService(
      buildConfig(),
      { reply } as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      { findUserIdByZaloId } as unknown as ZaloAccountLinkService,
      buildRateLimitService(),
    );

    await service.handleIncomingMessage('zalo-1', 'chào bạn');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('sự cố'),
    );
  });

  it('sends a welcome message on follow', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      {} as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      buildRateLimitService(),
    );

    await service.handleFollow('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('WISPACE'),
    );
  });

  it('sends a text-only fallback message for unsupported message types', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloChatService(
      buildConfig(),
      {} as unknown as ZaloAgentService,
      { sendText } as unknown as ZaloOutboundService,
      {} as unknown as ZaloAccountLinkService,
      buildRateLimitService(),
    );

    await service.handleUnsupportedMessage('zalo-1');

    expect(sendText).toHaveBeenCalledWith(
      'zalo-1',
      expect.stringContaining('văn bản'),
    );
  });
});
