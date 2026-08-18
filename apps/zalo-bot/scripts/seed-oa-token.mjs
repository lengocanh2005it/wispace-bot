#!/usr/bin/env node
// Seed the single-row zalo_oa_tokens table with an ENCRYPTED token pair.
//
// Tokens are AES-256-GCM encrypted at rest (ZALO_TOKEN_ENCRYPTION_KEY) — a
// raw SQL INSERT of plaintext values would fail closed on read. Run AFTER
// `npm run build` (the script imports the built transformer from dist/):
//
//   node scripts/seed-oa-token.mjs --access-token=... --refresh-token=...
//
// Requires the same env as the app (DB_* from .env.shared + ZALO_TOKEN_ENCRYPTION_KEY).
import { readFileSync } from 'fs';
import { createCipheriv, randomBytes } from 'crypto';
import pg from 'pg';

function loadEnv() {
  for (const candidate of ['../../../.env.shared', '../.env', '.env']) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!(key in process.env)) {
          process.env[key] = trimmed.slice(eq + 1).trim();
        }
      }
    } catch {
      // optional file — keep going
    }
  }
}

loadEnv();

const args = process.argv.slice(2);
function readArg(name) {
  const prefix = `--${name}=`;
  const match = args.find((a) => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const accessToken = readArg('access-token');
const refreshToken = readArg('refresh-token');
const expiresInSeconds = Number(readArg('expires-in') ?? '3600');
const refreshExpiresInSeconds = Number(
  readArg('refresh-expires-in') ?? '2592000',
);

if (!accessToken || !refreshToken) {
  console.error(
    'Usage: node scripts/seed-oa-token.mjs --access-token=... --refresh-token=... [--expires-in=3600] [--refresh-expires-in=2592000]',
  );
  process.exit(1);
}

// Same envelope format as oa-token-crypto.transformer.ts — keep in sync.
function encryptOaToken(plaintext) {
  const rawKey = process.env.ZALO_TOKEN_ENCRYPTION_KEY?.trim();
  if (!rawKey) {
    console.error('ZALO_TOKEN_ENCRYPTION_KEY must be set in .env');
    process.exit(1);
  }
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    console.error('ZALO_TOKEN_ENCRYPTION_KEY must decode to a 32-byte key');
    process.exit(1);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    'v1.' + [iv, tag, encrypted].map((b) => b.toString('base64')).join('.')
  );
}

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA || undefined }
      : undefined,
});

const now = new Date();
await pool.query(
  `INSERT INTO zalo_oa_tokens
    (access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, updated_at)
   VALUES ($1, $2, $3, $4, $5)`,
  [
    encryptOaToken(accessToken),
    encryptOaToken(refreshToken),
    new Date(now.getTime() + expiresInSeconds * 1000),
    new Date(now.getTime() + refreshExpiresInSeconds * 1000),
    now,
  ],
);

await pool.end();
console.log('zalo_oa_tokens seeded with an encrypted token pair');
