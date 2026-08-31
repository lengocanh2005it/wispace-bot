import pg from 'pg';

export function createPool(env = process.env, fallbacks = {}, sslOverride) {
  return new pg.Pool({
    host: env.DB_HOST ?? fallbacks.host,
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME,
    user: env.DB_USER ?? fallbacks.user,
    password: env.DB_PASSWORD,
    ssl:
      sslOverride ??
      (env.DB_SSL === 'true'
        ? { rejectUnauthorized: true, ca: env.DB_SSL_CA || undefined }
        : fallbacks.sslOff),
  });
}
