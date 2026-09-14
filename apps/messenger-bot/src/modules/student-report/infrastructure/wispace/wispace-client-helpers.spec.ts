import type { ConfigService } from '@nestjs/config';
import { buildWispaceClientConfig } from './wispace-client-helpers';

describe('buildWispaceClientConfig', () => {
  function config(values: Record<string, string | undefined>) {
    return {
      get: (key: string) => values[key],
    } as ConfigService;
  }

  it('rejects an unsafe configured URL before building the client', () => {
    expect(() =>
      buildWispaceClientConfig(
        config({
          NODE_ENV: 'production',
          WISPACE_INTERNAL_KEY: 'internal-key',
          WISPACE_API_TASK_SCORE_URL: 'http://backend.example.com/scores',
        }),
        'WISPACE_API_TASK_SCORE_URL',
      ),
    ).toThrow('WISPACE_API_TASK_SCORE_URL must use HTTPS');
  });

  it('validates the final fallback URL', () => {
    expect(() =>
      buildWispaceClientConfig(
        config({
          NODE_ENV: 'production',
          WISPACE_INTERNAL_KEY: 'internal-key',
        }),
        'WISPACE_API_USER_CALENDAR_URL',
        'http://backend.example.com/calendar',
      ),
    ).toThrow('WISPACE_API_USER_CALENDAR_URL must use HTTPS');
  });

  it('allows the existing localhost HTTP exception in test runtime', () => {
    expect(
      buildWispaceClientConfig(
        config({
          NODE_ENV: 'test',
          WISPACE_INTERNAL_KEY: 'internal-key',
          WISPACE_API_USER_CALENDAR_URL:
            'http://localhost:3000/api/UserCalendar',
        }),
        'WISPACE_API_USER_CALENDAR_URL',
      ).url,
    ).toBe('http://localhost:3000/api/UserCalendar');
  });
});
