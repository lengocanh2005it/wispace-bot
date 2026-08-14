import { WispaceConfigService } from './wispace-config.service';

function buildService(
  values: Record<string, string> = {},
): WispaceConfigService {
  const config: Record<string, string> = {
    WISPACE_API_PRECREATE_EXERCISE_URL: 'https://backend.example.com/precreate',
    WISPACE_INTERNAL_KEY: 'internal-key',
    ...values,
  };
  return new WispaceConfigService((key) => config[key]);
}

describe('WispaceConfigService precreate exercise config', () => {
  it('reads the exercise timeout from configuration', () => {
    const config = buildService({
      WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS: '30000',
    }).buildPrecreateExerciseClientConfig();

    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it.each([undefined, '', '0', '-1', '0.5', 'not-a-number'])(
    'rejects a missing or invalid exercise timeout: %s',
    (timeout) => {
      const values =
        timeout === undefined
          ? {}
          : { WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS: timeout };

      expect(() =>
        buildService(values).buildPrecreateExerciseClientConfig(),
      ).toThrow('WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS');
    },
  );
});

describe('WispaceConfigService upstream URL fail-closed', () => {
  it('accepts the default HTTPS fallback URLs', () => {
    const service = buildService();
    expect(service.buildGoalsClientConfig().url).toBe(
      'https://backend.aihubproduction.com/api/User/goals',
    );
  });

  it.each([
    'http://backend.example.com/api/User/goals',
    'https://user:pass@backend.example.com/api/User/goals',
    'https://backend.example.com/api/User/goals#section',
    'https://localhost/api/User/goals',
    'https://192.168.1.10/api/User/goals',
  ])('rejects an unsafe upstream URL at config time: %s', (url) => {
    expect(() =>
      buildService({
        WISPACE_API_USER_GOALS_URL: url,
      }).buildGoalsClientConfig(),
    ).toThrow('WISPACE_API_USER_GOALS_URL');
  });

  it('rejects a host outside WISPACE_ALLOWED_HOSTS', () => {
    expect(() =>
      buildService({
        WISPACE_API_USER_GOALS_URL: 'https://other.example.com/api/User/goals',
        WISPACE_ALLOWED_HOSTS: 'backend.example.com',
      }).buildGoalsClientConfig(),
    ).toThrow('is not in WISPACE_ALLOWED_HOSTS');
  });

  it('accepts a host listed in WISPACE_ALLOWED_HOSTS', () => {
    const config = buildService({
      WISPACE_ALLOWED_HOSTS: 'backend.aihubproduction.com',
    }).buildGoalsClientConfig();
    expect(config.url).toBe(
      'https://backend.aihubproduction.com/api/User/goals',
    );
  });

  it.each([
    [
      'buildTaskScoreClientConfig',
      'WISPACE_API_TASK_SCORE_URL',
      (s: WispaceConfigService) => s.buildTaskScoreClientConfig(),
    ],
    [
      'buildCalendarClientConfig',
      'WISPACE_API_USER_CALENDAR_URL',
      (s: WispaceConfigService) => s.buildCalendarClientConfig(),
    ],
    [
      'buildPrecreateExerciseClientConfig',
      'WISPACE_API_PRECREATE_EXERCISE_URL',
      (s: WispaceConfigService) => s.buildPrecreateExerciseClientConfig(),
    ],
  ] as const)('rejects an unsafe URL in %s', (_name, urlKey, builder) => {
    expect(() =>
      builder(
        buildService({
          [urlKey]: 'http://evil.com/x',
          WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS: '30000',
        }),
      ),
    ).toThrow();
  });
});
