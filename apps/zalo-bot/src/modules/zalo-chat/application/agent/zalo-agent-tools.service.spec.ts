import type { ConfigService } from '@nestjs/config';
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';

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

describe('ZaloAgentToolsService', () => {
  const service = new ZaloAgentToolsService(buildConfig());

  it('returns available:false with a link-account message when userId is not linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = (await service.execute('get_user_goals', '{}', ctx)) as {
      available: boolean;
      message: string;
    };
    expect(result.available).toBe(false);
    expect(result.message).toContain('liên kết');
  });

  it('returns available:false with a not-yet-built message when userId is linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1', userId: 42 };
    const result = (await service.execute('get_user_goals', '{}', ctx)) as {
      available: boolean;
      message: string;
    };
    expect(result.available).toBe(false);
    expect(result.message).toContain('phát triển');
  });

  it('returns an error object for an unknown tool name', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = (await service.execute('not_a_real_tool', '{}', ctx)) as {
      error: string;
    };
    expect(result.error).toContain('Unknown tool');
  });
});
