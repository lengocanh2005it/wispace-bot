/**
 * Strip IPv6 bracket notation (`[::1]` → `::1`) and normalize case.
 */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Check if an IPv4 octet string represents a loopback address (127.0.0.0/8).
 */
function isLoopbackIPv4(octets: number[]): boolean {
  return octets[0] === 127;
}

/**
 * Check if an IPv4 octet string represents a private/RFC1918 address.
 */
function isPrivateIPv4(octets: number[]): boolean {
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/**
 * Check if an IPv4 octet string represents a link-local address (169.254.0.0/16).
 */
function isLinkLocalIPv4(octets: number[]): boolean {
  return octets[0] === 169 && octets[1] === 254;
}

/**
 * Parse a hostname that might be an IPv4 address.
 * Returns the octets if valid, undefined otherwise.
 */
function parseIPv4(hostname: string): number[] | undefined {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }
  return octets;
}

/**
 * Parse an IPv6 address into 8 groups of 16-bit integers.
 * Handles :: compression, IPv4-mapped notation (::ffff:1.2.3.4).
 * Returns undefined if the input is not a valid IPv6 address.
 */
function parseIPv6(address: string): number[] | undefined {
  // Handle IPv4-mapped: ::ffff:1.2.3.4 → expand to full IPv6
  const ipv4MappedMatch = address.match(
    /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (ipv4MappedMatch) {
    const octets = parseIPv4(ipv4MappedMatch[1]);
    if (!octets) return undefined;
    // IPv4-mapped IPv6: 0000:0000:0000:0000:0000:ffff:aabb:ccdd
    if (address.toLowerCase().startsWith('::ffff:')) {
      return [
        0,
        0,
        0,
        0,
        0,
        0xffff,
        (octets[0] << 8) | octets[1],
        (octets[2] << 8) | octets[3],
      ];
    }
    // Direct IPv4 as IPv6: ::1.2.3.4 or just 1.2.3.4
    return [
      0,
      0,
      0,
      0,
      0,
      0,
      (octets[0] << 8) | octets[1],
      (octets[2] << 8) | octets[3],
    ];
  }

  // Handle :: compression
  const parts = address.split('::');
  if (parts.length > 2) return undefined;

  let leftParts: string[];
  let rightParts: string[];

  if (parts.length === 2) {
    leftParts = parts[0] ? parts[0].split(':') : [];
    rightParts = parts[1] ? parts[1].split(':') : [];
    const missingGroups = 8 - leftParts.length - rightParts.length;
    if (missingGroups < 1) return undefined; // :: must replace at least 1 group
    const middle = new Array(missingGroups).fill('0');
    const allParts = [...leftParts, ...middle, ...rightParts];
    if (allParts.length !== 8) return undefined;
    leftParts = allParts;
    rightParts = [];
  } else {
    leftParts = address.split(':');
    rightParts = [];
  }

  const allParts = [...leftParts, ...rightParts];
  if (allParts.length !== 8) return undefined;

  const groups = allParts.map((part) => {
    if (part === '') return 0; // leading/trailing colons
    const parsed = parseInt(part, 16);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xffff) return NaN;
    return parsed;
  });

  if (groups.some(Number.isNaN)) return undefined;
  return groups;
}

/**
 * Check if an IPv6 address is a loopback address (::1).
 */
function isLoopbackIPv6(groups: number[]): boolean {
  return (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  );
}

/**
 * Check if an IPv6 address is the unspecified address (::).
 */
function isUnspecifiedIPv6(groups: number[]): boolean {
  return groups.every((g) => g === 0);
}

/**
 * Check if an IPv6 address is a link-local address (fe80::/10).
 */
function isLinkLocalIPv6(groups: number[]): boolean {
  return (groups[0] & 0xffc0) === 0xfe80;
}

/**
 * Check if an IPv6 address is a unique local address (fc00::/7).
 * Covers both fc00::/8 (currently undefined) and fd00::/8 (random assigned).
 */
function isUniqueLocalIPv6(groups: number[]): boolean {
  return (groups[0] & 0xfe00) === 0xfc00;
}

/**
 * Fail-closed check for hostnames that resolve to private/loopback/link-local
 * networks. Covers IPv4 RFC1918 + loopback + link-local, and IPv6
 * loopback + unspecified + link-local + ULA + IPv4-mapped variants.
 *
 * Used as defense-in-depth alongside HTTPS enforcement and host allowlists.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);

  // Fast-path: well-known IPv4 strings
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::'
  ) {
    return true;
  }

  // Try IPv4 parse
  const ipv4Octets = parseIPv4(normalized);
  if (ipv4Octets) {
    return (
      isLoopbackIPv4(ipv4Octets) ||
      isPrivateIPv4(ipv4Octets) ||
      isLinkLocalIPv4(ipv4Octets)
    );
  }

  // Try IPv6 parse
  const ipv6Groups = parseIPv6(normalized);
  if (ipv6Groups) {
    // Extract embedded IPv4 from IPv4-mapped IPv6 (::ffff:1.2.3.4)
    const isIPv4Mapped = ipv6Groups[5] === 0xffff;
    const embeddedIPv4 = isIPv4Mapped
      ? [
          (ipv6Groups[6] >> 8) & 0xff,
          ipv6Groups[6] & 0xff,
          (ipv6Groups[7] >> 8) & 0xff,
          ipv6Groups[7] & 0xff,
        ]
      : undefined;

    return (
      isLoopbackIPv6(ipv6Groups) ||
      isUnspecifiedIPv6(ipv6Groups) ||
      isLinkLocalIPv6(ipv6Groups) ||
      isUniqueLocalIPv6(ipv6Groups) ||
      // IPv4-mapped private/loopback: ::ffff:192.168.1.1, ::ffff:127.0.0.1
      (embeddedIPv4 !== undefined &&
        (isPrivateIPv4(embeddedIPv4) || isLoopbackIPv4(embeddedIPv4)))
    );
  }

  return false;
}
