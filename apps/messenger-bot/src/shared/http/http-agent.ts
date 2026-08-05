import { Agent } from 'undici';

const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;
const CONNECTIONS_PER_HOST = 6;

const agents = new Map<string, Agent>();

function getHostFromUrl(url: string | URL): string {
  const href = typeof url === 'string' ? url : url.href;
  const match = href.match(/^https?:\/\/([^/]+)/);
  return match?.[1] ?? 'unknown';
}

export function getKeepAliveAgent(url: string | URL): Agent {
  const host = getHostFromUrl(url);
  const existing = agents.get(host);
  if (existing) return existing;

  const agent = new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: CONNECTIONS_PER_HOST,
    pipelining: 1,
  });
  agents.set(host, agent);
  return agent;
}

/**
 * Wrapper around fetch that attaches a keep-alive undici Agent for the target host.
 * Uses the dispatcher option which is supported by Node.js native fetch (undici-based).
 */
export async function keepAliveFetch(
  url: string | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init ?? {};
  const signal = timeoutMs
    ? AbortSignal.timeout(timeoutMs)
    : (rest.signal as AbortSignal | undefined);

  // dispatcher is an undici extension supported by Node.js native fetch
  const opts: RequestInit & { dispatcher?: Agent } = {
    ...rest,
    signal,
    dispatcher: getKeepAliveAgent(url),
  };

  return fetch(url, opts);
}
