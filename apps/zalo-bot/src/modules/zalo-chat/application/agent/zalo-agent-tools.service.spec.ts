import type { ConfigService } from '@nestjs/config';
import { ZaloAgentToolsService } from './zalo-agent-tools.service';
import type { ZaloAgentToolContext } from '../../domain/entities/zalo-chat.types';
import type { ZaloWispaceGoalsService } from '@zalo/modules/wispace/application/services/zalo-wispace-goals.service';
import type { ZaloWispaceCalendarService } from '@zalo/modules/wispace/application/services/zalo-wispace-calendar.service';

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

function buildGoalsService(): ZaloWispaceGoalsService {
  return {
    getUserGoals: () =>
      Promise.resolve({
        targetBand: '7.0',
        examDate: '2025-03-01',
        task1Band: '6.5',
        task2Band: '7.0',
      }),
    getTaskScoreAverages: () =>
      Promise.resolve([{ task1Count: 10, task2Count: 15 }]),
  } as unknown as ZaloWispaceGoalsService;
}

function buildCalendarService(): ZaloWispaceCalendarService {
  return {
    getCalendarSessions: () => Promise.resolve([]),
  } as unknown as ZaloWispaceCalendarService;
}

describe('ZaloAgentToolsService', () => {
  const service = new ZaloAgentToolsService(
    buildConfig(),
    buildGoalsService(),
    buildCalendarService(),
  );

  it('returns available:false with a link-account message when userId is not linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = (await service.execute('get_user_goals', '{}', ctx)) as {
      available: boolean;
      message: string;
    };
    expect(result.available).toBe(false);
    expect(result.message).toContain('liên kết');
  });

  it('returns goals when userId is linked', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1', userId: 42 };
    const result = (await service.execute('get_user_goals', '{}', ctx)) as {
      targetBand: string;
    };
    expect(result.targetBand).toBe('7.0');
  });

  it('returns formatted report for learning progress', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1', userId: 42 };
    const result = (await service.execute(
      'get_learning_progress_report',
      '{}',
      ctx,
    )) as string;
    expect(result).toContain('Báo cáo tiến độ');
    expect(result).toContain('7.0');
  });

  it('returns an error object for an unknown tool name', async () => {
    const ctx: ZaloAgentToolContext = { zaloUserId: 'zalo-1' };
    const result = (await service.execute('not_a_real_tool', '{}', ctx)) as {
      error: string;
    };
    expect(result.error).toContain('Unknown tool');
  });
});
