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
