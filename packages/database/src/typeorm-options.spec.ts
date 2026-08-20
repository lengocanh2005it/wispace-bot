import { getPostgresSsl, getTypeOrmOptions } from './typeorm-options';

describe('getPostgresSsl', () => {
  it('returns verify-only SSL config when TLS is enabled', () => {
    expect(getPostgresSsl({ DB_SSL: 'true' })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('passes the CA through when provided', () => {
    expect(getPostgresSsl({ DB_SSL: 'true', DB_SSL_CA: 'trusted-ca' })).toEqual(
      { rejectUnauthorized: true, ca: 'trusted-ca' },
    );
  });

  it.each([undefined, 'development', 'test', 'staging', 'production'])(
    'rejects a public IP host without TLS regardless of NODE_ENV: %s',
    (nodeEnv) => {
      const env = { DB_HOST: '69.62.74.196' } as Record<string, string>;
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;

      expect(() => getPostgresSsl(env)).toThrow('DB_SSL=true is required');
    },
  );

  it.each(['db.example.com', 'postgres', 'backend.aihubproduction.com'])(
    'rejects a non-IP hostname without TLS when not allowlisted: %s',
    (host) => {
      expect(() => getPostgresSsl({ DB_HOST: host })).toThrow(
        'DB_SSL=true is required',
      );
    },
  );

  it.each([
    'localhost',
    '127.0.0.1',
    '::1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.9.9',
    '192.168.1.10',
  ])('allows plaintext for local/private hosts: %s', (host) => {
    expect(getPostgresSsl({ DB_HOST: host })).toBe(false);
  });

  it('allows a non-IP hostname listed in DB_ALLOW_INSECURE_HOSTS', () => {
    expect(
      getPostgresSsl({
        DB_HOST: 'postgres',
        DB_ALLOW_INSECURE_HOSTS: 'postgres',
      }),
    ).toBe(false);
  });

  it('matches the allowlist case-insensitively and trims entries', () => {
    expect(
      getPostgresSsl({
        DB_HOST: 'Postgres',
        DB_ALLOW_INSECURE_HOSTS: ' redis, postgres, db.internal ',
      }),
    ).toBe(false);
  });

  it('still rejects a public host when the allowlist lists a different host', () => {
    expect(() =>
      getPostgresSsl({
        DB_HOST: '69.62.74.196',
        DB_ALLOW_INSECURE_HOSTS: 'postgres',
      }),
    ).toThrow('DB_SSL=true is required');
  });

  it('rejects an empty allowlist entry without weakening the check', () => {
    expect(() =>
      getPostgresSsl({
        DB_HOST: 'db.example.com',
        DB_ALLOW_INSECURE_HOSTS: '  , ',
      }),
    ).toThrow('DB_SSL=true is required');
  });
});

describe('getTypeOrmOptions pool configuration', () => {
  const baseEnv = {
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test_db',
  };

  it('places pool timeouts at pg.Pool top level, not nested under pool', () => {
    const opts = getTypeOrmOptions(
      {
        ...baseEnv,
        DB_POOL_IDLE_TIMEOUT_MS: '60000',
        DB_POOL_CONNECTION_TIMEOUT_MS: '3000',
      },
      [],
    );
    const extra = opts.extra as Record<string, unknown>;
    expect(extra.idleTimeoutMillis).toBe(60000);
    expect(extra.connectionTimeoutMillis).toBe(3000);
    expect(extra.pool).toBeUndefined();
  });

  it('defaults to 30s idle timeout and 5s connection timeout', () => {
    const opts = getTypeOrmOptions(baseEnv, []);
    const extra = opts.extra as Record<string, unknown>;
    expect(extra.idleTimeoutMillis).toBe(30_000);
    expect(extra.connectionTimeoutMillis).toBe(5_000);
  });

  it('applies DB_POOL_SIZE as poolSize', () => {
    const opts = getTypeOrmOptions({ ...baseEnv, DB_POOL_SIZE: '5' }, []);
    expect(opts.poolSize).toBe(5);
  });
});
