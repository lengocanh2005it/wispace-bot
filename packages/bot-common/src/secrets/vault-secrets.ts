import { Logger } from '@nestjs/common';
import { readBoundedJson } from '../utils/read-bounded-json';

export type VaultApplication = 'messenger' | 'discord' | 'zalo';
export type VaultEnvironment = Record<string, string | undefined>;

export interface VaultSecretsLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface VaultSecretPaths {
  shared: string;
  application: string;
}

export interface VaultSecretsLoaderOptions {
  application: VaultApplication;
  env?: VaultEnvironment;
  fetchImpl?: typeof fetch;
  logger?: VaultSecretsLogger;
  sharedOverrideKeys?: ReadonlySet<string>;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxValueBytes?: number;
  maxKeys?: number;
}

export type VaultRequestPhase = 'login' | 'shared' | 'application';

export class VaultSecretsError extends Error {
  constructor(
    message: string,
    readonly phase: VaultRequestPhase | 'configuration' | 'validation',
  ) {
    super(message);
    this.name = 'VaultSecretsError';
  }
}

export const VAULT_SECRET_MOUNT = 'secret';
export const VAULT_SECRET_NAMESPACE = 'wispace-bots';
export const VAULT_PRODUCTION_ENVIRONMENT = 'prd';
export const VAULT_DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const VAULT_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const VAULT_DEFAULT_MAX_VALUE_BYTES = 256 * 1024;
export const VAULT_DEFAULT_MAX_KEYS = 512;

const MAX_REQUEST_TIMEOUT_MS = 60_000;
const ENVIRONMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const BLOCKED_EXACT_KEYS = new Set([
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'BASH_ENV',
  'ENV',
  'CDPATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

const defaultLogger = new Logger('VaultSecrets');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBlockedKey(key: string): boolean {
  return (
    BLOCKED_EXACT_KEYS.has(key) ||
    key.startsWith('VAULT_') ||
    key.startsWith('NODE_') ||
    key.startsWith('LD_') ||
    key.startsWith('DYLD_')
  );
}

function validatePositiveLimit(value: number, name: string, maximum?: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new RangeError(`${name} exceeds the supported maximum`);
  }
}

function readLimits(options: VaultSecretsLoaderOptions) {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? VAULT_DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? VAULT_DEFAULT_MAX_RESPONSE_BYTES;
  const maxValueBytes = options.maxValueBytes ?? VAULT_DEFAULT_MAX_VALUE_BYTES;
  const maxKeys = options.maxKeys ?? VAULT_DEFAULT_MAX_KEYS;

  validatePositiveLimit(
    requestTimeoutMs,
    'requestTimeoutMs',
    MAX_REQUEST_TIMEOUT_MS,
  );
  validatePositiveLimit(maxResponseBytes, 'maxResponseBytes');
  validatePositiveLimit(maxValueBytes, 'maxValueBytes');
  validatePositiveLimit(maxKeys, 'maxKeys');

  return { requestTimeoutMs, maxResponseBytes, maxValueBytes, maxKeys };
}

function validateApplication(
  application: string,
): asserts application is VaultApplication {
  if (
    application !== 'messenger' &&
    application !== 'discord' &&
    application !== 'zalo'
  ) {
    throw new VaultSecretsError(
      'unsupported Vault application',
      'configuration',
    );
  }
}

function validateEnvironment(environment: string): string {
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new VaultSecretsError(
      'VAULT_ENV must contain only lowercase letters, digits, and hyphens',
      'configuration',
    );
  }
  return environment;
}

export function resolveVaultSecretPaths(
  application: VaultApplication,
  environment = VAULT_PRODUCTION_ENVIRONMENT,
): VaultSecretPaths {
  validateApplication(application);
  const normalizedEnvironment = validateEnvironment(environment);
  return {
    shared: `${VAULT_SECRET_MOUNT}/data/${VAULT_SECRET_NAMESPACE}/shared/${normalizedEnvironment}`,
    application: `${VAULT_SECRET_MOUNT}/data/${VAULT_SECRET_NAMESPACE}/${application}/${normalizedEnvironment}`,
  };
}

function parseBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new VaultSecretsError(`${name} must be true or false`, 'configuration');
}

function normalizeVaultAddress(value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new VaultSecretsError('VAULT_ADDR is invalid', 'configuration');
  }

  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) {
    throw new VaultSecretsError('VAULT_ADDR must use HTTPS', 'configuration');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VaultSecretsError(
      'VAULT_ADDR must not contain credentials, query, or fragment data',
      'configuration',
    );
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

function hasPartialVaultConfiguration(env: VaultEnvironment): boolean {
  return [
    env.VAULT_ADDR,
    env.VAULT_ROLE_ID,
    env.VAULT_SECRET_ID,
    env.VAULT_ENV,
    env.VAULT_SECRET_PATH,
  ].some((value) => typeof value === 'string' && value.trim() !== '');
}

function validateOverrideKeys(keys: ReadonlySet<string>): void {
  for (const key of keys) {
    if (!ENV_KEY_PATTERN.test(key) || isBlockedKey(key)) {
      throw new VaultSecretsError(
        'sharedOverrideKeys contains an invalid key',
        'configuration',
      );
    }
  }
}

function getVaultConfiguration(
  env: VaultEnvironment,
  logger: VaultSecretsLogger,
): { address: string; environment: string } | undefined {
  const production = env.NODE_ENV === 'production';
  const parsedRequired = parseBoolean(env.VAULT_REQUIRED, 'VAULT_REQUIRED');
  const hasPartialConfiguration = hasPartialVaultConfiguration(env);

  if (production && parsedRequired !== true) {
    throw new VaultSecretsError(
      'production requires VAULT_REQUIRED=true',
      'configuration',
    );
  }

  if (parsedRequired === false && !production) {
    if (hasPartialConfiguration) {
      throw new VaultSecretsError(
        'partial Vault configuration cannot be used with VAULT_REQUIRED=false',
        'configuration',
      );
    }
    logger.warn('Vault disabled — VAULT_REQUIRED=false');
    return undefined;
  }

  const rawAddress = env.VAULT_ADDR?.trim();
  if (!rawAddress) {
    if (parsedRequired === true || hasPartialConfiguration) {
      throw new VaultSecretsError('VAULT_ADDR is required', 'configuration');
    }
    logger.warn('Vault disabled — VAULT_ADDR is not configured');
    return undefined;
  }

  if (env.VAULT_SECRET_PATH?.trim()) {
    throw new VaultSecretsError(
      'VAULT_SECRET_PATH is not supported; use the canonical Vault paths',
      'configuration',
    );
  }

  const rawEnvironment =
    env.VAULT_ENV?.trim() ||
    (production ? VAULT_PRODUCTION_ENVIRONMENT : 'dev');
  const environment = validateEnvironment(rawEnvironment);
  if (production && environment !== VAULT_PRODUCTION_ENVIRONMENT) {
    throw new VaultSecretsError(
      `production requires VAULT_ENV=${VAULT_PRODUCTION_ENVIRONMENT}`,
      'configuration',
    );
  }

  return {
    address: normalizeVaultAddress(rawAddress, production),
    environment,
  };
}

function extractClientToken(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.auth)) {
    throw new VaultSecretsError('Vault login response is malformed', 'login');
  }
  const token = payload.auth.client_token;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new VaultSecretsError('Vault login response is malformed', 'login');
  }
  return token.trim();
}

function validateSecretData(
  payload: unknown,
  phase: Exclude<VaultRequestPhase, 'login'>,
  maxKeys: number,
  maxValueBytes: number,
): Record<string, string> {
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    !isRecord(payload.data.data)
  ) {
    throw new VaultSecretsError(
      `Vault ${phase} secret response is malformed`,
      'validation',
    );
  }

  const entries = Object.entries(payload.data.data);
  if (entries.length > maxKeys) {
    throw new VaultSecretsError(
      `Vault ${phase} secret response is malformed`,
      'validation',
    );
  }

  const secrets = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (
      !ENV_KEY_PATTERN.test(key) ||
      isBlockedKey(key) ||
      typeof value !== 'string' ||
      Buffer.byteLength(value, 'utf8') > maxValueBytes
    ) {
      throw new VaultSecretsError(
        `Vault ${phase} secret response is malformed`,
        'validation',
      );
    }
    secrets[key] = value;
  }
  return secrets;
}

async function readVaultJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error('response exceeds limit');
    }
  }

  if (response.body) {
    return readBoundedJson<T>(response, maxBytes);
  }

  let text: string;
  if (typeof response.text === 'function') {
    text = await response.text();
  } else if (typeof response.json === 'function') {
    const value = await response.json();
    text = JSON.stringify(value);
  } else {
    throw new Error('response body is unavailable');
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('response exceeds limit');
  }
  return JSON.parse(text) as T;
}

async function requestVaultJson<T>(
  fetchImpl: typeof fetch,
  address: string,
  path: string,
  phase: VaultRequestPhase,
  init: RequestInit,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${address}/v1/${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new VaultSecretsError(`Vault ${phase} request failed`, phase);
    }

    if (!response.ok) {
      const label = phase === 'login' ? 'login' : `${phase} secret fetch`;
      throw new VaultSecretsError(
        `Vault ${label} failed (HTTP ${response.status})`,
        phase,
      );
    }

    try {
      return await readVaultJson<T>(response, maxResponseBytes);
    } catch {
      throw new VaultSecretsError(
        `Vault ${phase === 'login' ? 'login' : `${phase} secret`} response is malformed`,
        phase,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function mergeSecrets(
  shared: Record<string, string>,
  application: Record<string, string>,
  sharedOverrideKeys: ReadonlySet<string>,
): Record<string, string> {
  const merged = Object.create(null) as Record<string, string>;
  Object.assign(merged, shared);

  for (const [key, value] of Object.entries(application)) {
    if (
      Object.prototype.hasOwnProperty.call(merged, key) &&
      !sharedOverrideKeys.has(key)
    ) {
      throw new VaultSecretsError(`duplicate Vault key ${key}`, 'validation');
    }
    merged[key] = value;
  }
  return merged;
}

export async function loadVaultSecrets(
  options: VaultSecretsLoaderOptions,
): Promise<void> {
  validateApplication(options.application);
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  try {
    const configuration = getVaultConfiguration(env, logger);
    if (!configuration) return;

    const limits = readLimits(options);
    const sharedOverrideKeys = options.sharedOverrideKeys ?? new Set<string>();
    validateOverrideKeys(sharedOverrideKeys);

    const roleId = env.VAULT_ROLE_ID?.trim();
    const secretId = env.VAULT_SECRET_ID?.trim();
    if (!roleId || !secretId) {
      throw new VaultSecretsError(
        'VAULT_ROLE_ID and VAULT_SECRET_ID are required',
        'configuration',
      );
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new VaultSecretsError(
        'global fetch is unavailable',
        'configuration',
      );
    }

    const paths = resolveVaultSecretPaths(
      options.application,
      configuration.environment,
    );

    const login = await requestVaultJson<{ auth: { client_token: string } }>(
      fetchImpl,
      configuration.address,
      'auth/approle/login',
      'login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
      },
      limits.requestTimeoutMs,
      limits.maxResponseBytes,
    );
    const token = extractClientToken(login);

    const sharedPayload = await requestVaultJson<unknown>(
      fetchImpl,
      configuration.address,
      paths.shared,
      'shared',
      { headers: { 'X-Vault-Token': token } },
      limits.requestTimeoutMs,
      limits.maxResponseBytes,
    );
    const shared = validateSecretData(
      sharedPayload,
      'shared',
      limits.maxKeys,
      limits.maxValueBytes,
    );
    const applicationPayload = await requestVaultJson<unknown>(
      fetchImpl,
      configuration.address,
      paths.application,
      'application',
      { headers: { 'X-Vault-Token': token } },
      limits.requestTimeoutMs,
      limits.maxResponseBytes,
    );
    const application = validateSecretData(
      applicationPayload,
      'application',
      limits.maxKeys,
      limits.maxValueBytes,
    );
    const merged = mergeSecrets(shared, application, sharedOverrideKeys);

    for (const [key, value] of Object.entries(merged)) {
      env[key] = value;
    }
    logger.log(
      `Loaded Vault secrets for ${options.application}: ${Object.keys(merged).length} env vars`,
    );
  } finally {
    delete env.VAULT_ROLE_ID;
    delete env.VAULT_SECRET_ID;
  }
}
