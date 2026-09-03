import { Agent } from 'undici';

/** Default connections per host — mirrors the Messenger reference. */
export const DEFAULT_KEEP_ALIVE_POOL_SIZE = 6;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;

export interface KeepAliveLogger {
  log(message: string): void;
}

export interface KeepAliveFetchOptions {
  /** Connections per host. Default: 6. First creator wins per host. */
  poolSize?: number;
  /** Called once when an agent is created for a new host (ops visibility). */
  logger?: KeepAliveLogger;
}

const agents = new Map<string, Agent>();

function getHostFromUrl(url: string | URL): string {
  const href = typeof url === 'string' ? url : url.href;
  const match = href.match(/^https?:\/\/([^/]+)/);
  return match?.[1] ?? 'unknown';
}

function resolvePoolSize(poolSize?: number): number {
  return poolSize && Number.isFinite(poolSize) && poolSize > 0
    ? Math.floor(poolSize)
    : DEFAULT_KEEP_ALIVE_POOL_SIZE;
}

/**
 * Shared keep-alive agent, one per host (#567). Connections idle-timeout
 * themselves — production never closes these; `closeKeepAliveAgents` exists
 * for tests.
 */
export function getKeepAliveAgent(
  url: string | URL,
  poolSize?: number,
  logger?: KeepAliveLogger,
): Agent {
  const host = getHostFromUrl(url);
  const existing = agents.get(host);
  if (existing) return existing;

  const resolved = resolvePoolSize(poolSize);
  const agent = new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: resolved,
    pipelining: 1,
  });
  agents.set(host, agent);
  logger?.log(`Keep-alive agent created host=${host} poolSize=${resolved}`);
  return agent;
}

/**
 * fetch() with a shared keep-alive dispatcher for the target host. The
 * caller's init (including signal) passes through untouched — timeout/abort
 * composition (e.g. mergeWithTimeout) stays entirely with the caller.
 * `dispatcher` is an undici extension supported by Node.js native fetch.
 */
export function keepAliveFetch(
  url: string | URL,
  init?: RequestInit,
  options?: KeepAliveFetchOptions,
): Promise<Response> {
  const opts = {
    ...init,
    dispatcher: getKeepAliveAgent(url, options?.poolSize, options?.logger),
  } as RequestInit & { dispatcher: Agent };
  return fetch(url, opts);
}

/**
 * Closes all pooled agents and clears the registry. Test/lifecycle hook
 * only — production relies on idle timeouts instead.
 */
export async function closeKeepAliveAgents(): Promise<void> {
  const pending = [...agents.values()].map((agent) => agent.close());
  agents.clear();
  await Promise.all(pending);
}
