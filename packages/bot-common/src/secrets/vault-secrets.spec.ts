import {
  loadVaultSecrets,
  resolveVaultSecretPaths,
  type VaultApplication,
} from './vault-secrets';

type TestEnvironment = Record<string, string | undefined>;

const VAULT_ADDR = 'https://vault.example.test';

function vaultResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function productionEnvironment(): TestEnvironment {
  return {
    NODE_ENV: 'production',
    VAULT_REQUIRED: 'true',
    VAULT_ADDR,
    VAULT_ROLE_ID: 'role-id-for-test',
    VAULT_SECRET_ID: 'secret-id-for-test',
  };
}

function mockLogger() {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe('loadVaultSecrets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['messenger', 'discord', 'zalo'] as VaultApplication[])(
    'loads shared and %s secrets through the canonical paths',
    async (application) => {
      const env = productionEnvironment();
      const logger = mockLogger();
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      const paths = resolveVaultSecretPaths(application, 'prd');
      fetchImpl
        .mockResolvedValueOnce(
          vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
        )
        .mockResolvedValueOnce(
          vaultResponse({
            data: {
              data: {
                SHARED_SETTING: 'shared-value',
                OVERRIDABLE_SETTING: 'shared-value',
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          vaultResponse({
            data: {
              data: {
                APP_SETTING: `${application}-value`,
                OVERRIDABLE_SETTING: 'app-value',
              },
            },
          }),
        );

      await loadVaultSecrets({
        application,
        env,
        fetchImpl,
        logger,
        sharedOverrideKeys: new Set(['OVERRIDABLE_SETTING']),
      });

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        `${VAULT_ADDR}/v1/auth/approle/login`,
      );
      expect(fetchImpl.mock.calls[1]?.[0]).toBe(
        `${VAULT_ADDR}/v1/${paths.shared}`,
      );
      expect(fetchImpl.mock.calls[2]?.[0]).toBe(
        `${VAULT_ADDR}/v1/${paths.application}`,
      );
      expect(fetchImpl.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          headers: { 'X-Vault-Token': 'client-token-for-test' },
          redirect: 'error',
        }),
      );
      expect(env.SHARED_SETTING).toBe('shared-value');
      expect(env.APP_SETTING).toBe(`${application}-value`);
      expect(env.OVERRIDABLE_SETTING).toBe('app-value');
      expect(env.VAULT_ROLE_ID).toBeUndefined();
      expect(env.VAULT_SECRET_ID).toBeUndefined();
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining(`Loaded Vault secrets for ${application}`),
      );
    },
  );

  it.each(['messenger', 'discord', 'zalo'] as VaultApplication[])(
    'does not inject shared values when the %s application path fails',
    async (application) => {
      const env = productionEnvironment();
      env.EXISTING_VALUE = 'keep-me';
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl
        .mockResolvedValueOnce(
          vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
        )
        .mockResolvedValueOnce(
          vaultResponse({
            data: { data: { SHARED_SETTING: 'must-not-leak' } },
          }),
        )
        .mockResolvedValueOnce(vaultResponse({ error: 'not found' }, 404));

      await expect(
        loadVaultSecrets({
          application,
          env,
          fetchImpl,
          logger: mockLogger(),
        }),
      ).rejects.toThrow('Vault application secret fetch failed (HTTP 404)');

      expect(env.SHARED_SETTING).toBeUndefined();
      expect(env.EXISTING_VALUE).toBe('keep-me');
    },
  );

  it('fails production startup when Vault is not explicitly required', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'production',
      VAULT_ADDR,
      VAULT_ROLE_ID: 'role-id-for-test',
      VAULT_SECRET_ID: 'secret-id-for-test',
    };
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_REQUIRED=true');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when Vault is required but VAULT_ADDR is missing', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'test',
      VAULT_REQUIRED: 'true',
      VAULT_ROLE_ID: 'role-id-for-test',
      VAULT_SECRET_ID: 'secret-id-for-test',
    };

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_ADDR is required');
  });

  it('allows non-production local startup without Vault', async () => {
    const env: TestEnvironment = { NODE_ENV: 'test' };
    const logger = mockLogger();

    await loadVaultSecrets({
      application: 'messenger',
      env,
      fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Vault disabled — VAULT_ADDR is not configured',
    );
  });

  it('rejects partial Vault configuration instead of silently falling back', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'test',
      VAULT_ROLE_ID: 'role-id-for-test',
    };

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_ADDR is required');
  });

  it('rejects partial configuration even when Vault is explicitly disabled', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'test',
      VAULT_REQUIRED: 'false',
      VAULT_ROLE_ID: 'role-id-for-test',
    };

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('partial Vault configuration');
  });

  it('rejects an address-only configuration when Vault is explicitly disabled', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'test',
      VAULT_REQUIRED: 'false',
      VAULT_ADDR,
    };

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('partial Vault configuration');
  });

  it('clears AppRole material when required credentials are incomplete', async () => {
    const env: TestEnvironment = {
      NODE_ENV: 'production',
      VAULT_REQUIRED: 'true',
      VAULT_ADDR,
      VAULT_ROLE_ID: 'role-id-for-test',
    };

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_ROLE_ID and VAULT_SECRET_ID are required');
    expect(env.VAULT_ROLE_ID).toBeUndefined();
    expect(env.VAULT_SECRET_ID).toBeUndefined();
  });

  it('rejects duplicate keys unless they are explicitly allowlisted', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { DUPLICATE_KEY: 'shared' } } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { DUPLICATE_KEY: 'application' } } }),
      );

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('duplicate Vault key DUPLICATE_KEY');
    expect(env.DUPLICATE_KEY).toBeUndefined();
  });

  it('rejects malformed and non-string secret values before injection', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { VALID_KEY: 'valid' } } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { INVALID_VALUE: { nested: true } } } }),
      );

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('Vault application secret response is malformed');
    expect(env.VALID_KEY).toBeUndefined();
  });

  it('rejects process-control and bootstrap keys from Vault', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { NODE_OPTIONS: '--inspect' } } }),
      );

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('Vault shared secret response is malformed');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('does not expose response bodies, AppRole material, or tokens in errors', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockResolvedValueOnce(
      vaultResponse(
        {
          error: 'secret_id=secret-id-for-test token=client-token-for-test',
        },
        500,
      ),
    );

    const result = loadVaultSecrets({
      application: 'messenger',
      env,
      fetchImpl,
      logger: mockLogger(),
    });

    await expect(result).rejects.toThrow('Vault login failed (HTTP 500)');
    await expect(result).rejects.not.toThrow('secret-id-for-test');
    await expect(result).rejects.not.toThrow('client-token-for-test');
  });

  it('aborts a hung Vault request at the per-request timeout', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
        requestTimeoutMs: 1,
      }),
    ).rejects.toThrow('Vault login request failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['messenger', 'discord', 'zalo'] as VaultApplication[])(
    'reloads the current Vault values on a later %s bootstrap for rotation',
    async (application) => {
      const env = productionEnvironment();
      const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
      fetchImpl
        .mockResolvedValueOnce(
          vaultResponse({ auth: { client_token: 'first-client-token' } }),
        )
        .mockResolvedValueOnce(
          vaultResponse({ data: { data: { ROTATING_VALUE: 'old' } } }),
        )
        .mockResolvedValueOnce(vaultResponse({ data: { data: {} } }))
        .mockResolvedValueOnce(
          vaultResponse({ auth: { client_token: 'second-client-token' } }),
        )
        .mockResolvedValueOnce(
          vaultResponse({ data: { data: { ROTATING_VALUE: 'new' } } }),
        )
        .mockResolvedValueOnce(vaultResponse({ data: { data: {} } }));

      await loadVaultSecrets({
        application,
        env,
        fetchImpl,
        logger: mockLogger(),
      });
      expect(env.ROTATING_VALUE).toBe('old');

      env.VAULT_ROLE_ID = 'rotated-role-id';
      env.VAULT_SECRET_ID = 'rotated-secret-id';
      await loadVaultSecrets({
        application,
        env,
        fetchImpl,
        logger: mockLogger(),
      });
      expect(env.ROTATING_VALUE).toBe('new');
    },
  );

  it('requires HTTPS for production Vault addresses', async () => {
    const env = productionEnvironment();
    env.VAULT_ADDR = 'http://vault.example.test';

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_ADDR must use HTTPS');
  });

  it('rejects the legacy arbitrary path override', async () => {
    const env = productionEnvironment();
    env.VAULT_SECRET_PATH = 'secret/data/legacy/prd';

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl: jest.fn() as jest.MockedFunction<typeof fetch>,
        logger: mockLogger(),
      }),
    ).rejects.toThrow('VAULT_SECRET_PATH is not supported');
  });

  it('enforces bounded value sizes', async () => {
    const env = productionEnvironment();
    const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchImpl
      .mockResolvedValueOnce(
        vaultResponse({ auth: { client_token: 'client-token-for-test' } }),
      )
      .mockResolvedValueOnce(
        vaultResponse({ data: { data: { LARGE_VALUE: '123456' } } }),
      );

    await expect(
      loadVaultSecrets({
        application: 'messenger',
        env,
        fetchImpl,
        logger: mockLogger(),
        maxValueBytes: 5,
      }),
    ).rejects.toThrow('Vault shared secret response is malformed');
    expect(env.LARGE_VALUE).toBeUndefined();
  });
});

describe('resolveVaultSecretPaths', () => {
  it.each(['messenger', 'discord', 'zalo'] as VaultApplication[])(
    'builds the namespaced %s paths',
    (application) => {
      expect(resolveVaultSecretPaths(application, 'prd')).toEqual({
        shared: 'secret/data/wispace-bots/shared/prd',
        application: `secret/data/wispace-bots/${application}/prd`,
      });
    },
  );
});
