import { createStartupValidationRunner } from '@wispace/bot-common/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateStartupConfig } from './config-validation';
import { ZALO_BACKGROUND_PRODUCERS } from './modules/zalo-chat/report-producer';

/** A release-image baseline: production NODE_ENV, Vault-delivered secrets. */
const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  INTERNAL_API_KEY: 'internal-ops-key-42',
  DB_HOST: 'db.example.com',
  DB_SSL: 'true',
  OPENAI_API_KEY: 'sk-proj-valid-key',
  OPENAI_MODEL: 'gpt-5.4',
  LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
  LLM_ALLOWED_BASE_URLS: 'api.openai.com',
};

describe('validateStartupConfig', () => {
  it('reports nothing for a configuration the app would boot on', () => {
    expect(validateStartupConfig(VALID_ENV)).toEqual([]);
  });

  it('reports a provider credential the app would refuse to start on', () => {
    const violations = validateStartupConfig({
      ...VALID_ENV,
      OPENAI_API_KEY: 'sk-or-v1-openrouter-credential',
    });

    expect(violations).toEqual([
      {
        scope: 'LLM provider configuration',
        message:
          'LLM provider openai has an invalid API key format (OPENAI_API_KEY); expected an OpenAI sk- key',
      },
    ]);
  });

  it('reports an unsecured public database host even with no pinned producer', () => {
    const violations = validateStartupConfig({
      ...VALID_ENV,
      DB_SSL: undefined,
    });

    expect(violations).toEqual([
      {
        scope: 'DB_SSL',
        message: expect.stringContaining('DB_SSL=true is required'),
      },
    ]);
  });
});

describe('the zalo startup validation entry point', () => {
  const originalEnv = process.env;
  let errorSpy: jest.SpyInstance;
  let runStartupValidation: () => Promise<number>;

  beforeEach(() => {
    process.env = { ...VALID_ENV };
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    runStartupValidation = createStartupValidationRunner({
      application: 'zalo',
      collect: validateStartupConfig,
      loadSecrets: async () => {},
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('exits zero when every constraint holds', async () => {
    await expect(runStartupValidation()).resolves.toBe(0);
  });

  it('exits non-zero and names the offending key', async () => {
    process.env.OPENAI_API_KEY = 'sk-or-v1-openrouter-credential';

    await expect(runStartupValidation()).resolves.toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'ERROR: startup validation: LLM provider configuration: LLM provider openai has an invalid API key format (OPENAI_API_KEY); expected an OpenAI sk- key',
    );
  });
});

describe('background producer inventory', () => {
  /**
   * Every producer-concurrency env key this app names must appear in the probe
   * list, or startup validation would pass a value the application refuses to
   * start on — the #1499 failure mode itself.
   */
  function producerConcurrencyKeysInSource(): Set<string> {
    const srcRoot = join(__dirname);
    const keys = new Set<string>();

    for (const entry of readdirSync(srcRoot, {
      recursive: true,
      encoding: 'utf8',
    })) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      const source = readFileSync(join(srcRoot, entry), 'utf8');
      for (const match of source.matchAll(
        /['"]([A-Z0-9_]*_SEND_CONCURRENCY)['"]/g,
      )) {
        keys.add(match[1]);
      }
    }

    return keys;
  }

  it('covers every producer concurrency key this app reads', () => {
    const declared = new Set(
      ZALO_BACKGROUND_PRODUCERS.map((producer) => producer.concurrencyEnvKey),
    );

    expect(producerConcurrencyKeysInSource()).toEqual(declared);
  });
});
