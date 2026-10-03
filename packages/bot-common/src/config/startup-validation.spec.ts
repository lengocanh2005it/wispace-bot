import {
  collectCommonStartupViolations,
  createStartupValidationRunner,
  reportStartupViolations,
} from './startup-validation';

const VALID_ENV = {
  INTERNAL_API_KEY: 'internal-ops-key-42',
  DB_HOST: 'db.example.com',
  DB_SSL: 'true',
};

describe('collectCommonStartupViolations', () => {
  it('reports nothing when every shared fail-closed constraint holds', () => {
    expect(collectCommonStartupViolations(VALID_ENV)).toEqual([]);
  });

  it('names INTERNAL_API_KEY when the ops key is absent', () => {
    const violations = collectCommonStartupViolations({
      DB_HOST: 'db.example.com',
      DB_SSL: 'true',
    });

    expect(violations).toEqual([
      {
        scope: 'INTERNAL_API_KEY',
        message: expect.stringContaining('INTERNAL_API_KEY is required'),
      },
    ]);
  });

  it('names DB_SSL when a public database host would be reached without TLS', () => {
    const violations = collectCommonStartupViolations({
      INTERNAL_API_KEY: 'internal-ops-key-42',
      DB_HOST: 'db.example.com',
    });

    expect(violations).toEqual([
      {
        scope: 'DB_SSL',
        message: expect.stringContaining('DB_SSL=true is required'),
      },
    ]);
  });

  it('reports every offending key in one pass rather than only the first', () => {
    const violations = collectCommonStartupViolations({
      DB_HOST: 'db.example.com',
    });

    expect(violations.map((violation) => violation.scope)).toEqual([
      'INTERNAL_API_KEY',
      'DB_SSL',
    ]);
  });

  it('accepts an unsecured database host listed in DB_ALLOW_INSECURE_HOSTS', () => {
    const violations = collectCommonStartupViolations({
      ...VALID_ENV,
      DB_SSL: undefined,
      DB_HOST: 'pgbouncer',
      DB_ALLOW_INSECURE_HOSTS: 'pgbouncer',
    });

    expect(violations).toEqual([]);
  });
});

describe('reportStartupViolations', () => {
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('returns zero and confirms the pass when nothing is wrong', () => {
    expect(reportStartupViolations([])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('Startup validation passed.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns non-zero and names every offending key', () => {
    const code = reportStartupViolations([
      { scope: 'INTERNAL_API_KEY', message: 'INTERNAL_API_KEY is required' },
      { scope: 'DB_SSL', message: 'DB_SSL=true is required' },
    ]);

    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'ERROR: startup validation: INTERNAL_API_KEY: INTERNAL_API_KEY is required',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'ERROR: startup validation: DB_SSL: DB_SSL=true is required',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'ERROR: startup validation found 2 offending key(s) — refusing to deploy (#1499)',
    );
  });
});

describe('createStartupValidationRunner', () => {
  const originalEnv = process.env;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {};
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('collects from the environment that Vault resolved', async () => {
    process.env.INTERNAL_API_KEY = 'internal-ops-key-42';
    process.env.DB_HOST = 'db.example.com';
    process.env.DB_SSL = 'true';
    const run = createStartupValidationRunner({
      application: 'messenger',
      collect: (env) =>
        collectCommonStartupViolations(env as Record<string, string>),
      loadSecrets: async () => {},
    });

    await expect(run()).resolves.toBe(0);
  });

  it('fails closed when Vault secrets cannot be loaded', async () => {
    const run = createStartupValidationRunner({
      application: 'messenger',
      collect: () => [],
      loadSecrets: async () => {
        throw new Error('approle login rejected');
      },
    });

    await expect(run()).resolves.toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not load Vault secrets'),
    );
  });
});
