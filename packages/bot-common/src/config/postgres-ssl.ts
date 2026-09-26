import { isPrivateNetworkHost } from '../utils/network-utils';

/** Build the shared TLS policy for PostgreSQL runtime and operational clients. */
export function getPostgresSsl(
  get: (key: string) => string | undefined,
): false | { rejectUnauthorized: true; ca?: string } {
  if (get('DB_SSL') !== 'true') {
    const host = get('DB_HOST')?.trim() ?? '';
    const allowlistedHosts = (get('DB_ALLOW_INSECURE_HOSTS') ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '');
    if (
      !isPrivateNetworkHost(host) &&
      !allowlistedHosts.includes(host.toLowerCase())
    ) {
      throw new Error(
        'DB_SSL=true is required for database hosts outside a private/local network (or list the host in DB_ALLOW_INSECURE_HOSTS)',
      );
    }
    return false;
  }

  const ca = get('DB_SSL_CA')?.trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
