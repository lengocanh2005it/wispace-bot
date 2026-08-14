const LOOPBACK_HOST_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export interface UpstreamUrlPolicy {
  /** Env var name — used in error messages and for startup fail-closed context. */
  context: string;
  nodeEnv?: string;
  /** Optional comma-split allowlist (WISPACE_ALLOWED_HOSTS). */
  allowedHosts?: readonly string[];
}

/** Shared option builder — dedup the repeated configService extraction across call sites. */
export function buildUpstreamUrlPolicy(
  context: string,
  configService: { get: (key: string) => string | undefined },
): UpstreamUrlPolicy {
  return {
    context,
    nodeEnv: configService.get('NODE_ENV'),
    allowedHosts: configService.get('WISPACE_ALLOWED_HOSTS')?.split(','),
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    LOOPBACK_HOST_RE.test(normalized)
  );
}

function isPrivateNetworkHost(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isDevelopmentLike(nodeEnv: string | undefined): boolean {
  const env = nodeEnv?.trim().toLowerCase();
  return env === 'development' || env === 'test';
}

/**
 * Fail-closed validation for every WISPACE upstream URL. Requires HTTPS
 * (except http://loopback in an explicit development/test environment),
 * rejects embedded credentials and fragments, rejects loopback/private
 * targets outside development, and enforces an optional host allowlist.
 * Throws so misconfiguration fails at startup instead of at first call.
 */
export function validateUpstreamUrl(
  value: string,
  policy: UpstreamUrlPolicy,
): string {
  const url = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${policy.context} must be a valid URL`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${policy.context} must not contain credentials`);
  }

  if (parsed.hash) {
    throw new Error(`${policy.context} must not contain a fragment`);
  }

  const isDevelopment = isDevelopmentLike(policy.nodeEnv);
  const isLoopback = isLoopbackHost(parsed.hostname);

  if (parsed.protocol !== 'https:') {
    const isDevLoopbackHttp =
      parsed.protocol === 'http:' && isDevelopment && isLoopback;
    if (!isDevLoopbackHttp) {
      throw new Error(`${policy.context} must use HTTPS`);
    }
  }

  const env = policy.nodeEnv?.trim().toLowerCase();
  const isProduction = env === undefined || env === 'production';
  if (isProduction && (isLoopback || isPrivateNetworkHost(parsed.hostname))) {
    throw new Error(
      `${policy.context} must not target localhost or a private network in production`,
    );
  }

  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    const normalizedHost = parsed.hostname.toLowerCase();
    const matched = policy.allowedHosts.some(
      (host) => host.trim().toLowerCase() === normalizedHost,
    );
    if (!matched) {
      throw new Error(
        `${policy.context} host ${parsed.hostname} is not in WISPACE_ALLOWED_HOSTS`,
      );
    }
  }

  return url;
}
