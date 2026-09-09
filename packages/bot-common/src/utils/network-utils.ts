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
 * Handles :: compression and any trailing IPv4 dotted-quad
 * (`::ffff:1.2.3.4`, `::1.2.3.4`, `64:ff9b::1.2.3.4`).
 * Returns undefined if the input is not a valid IPv6 address.
 */
function parseIPv6(address: string): number[] | undefined {
  // A trailing IPv4 dotted-quad encodes the last 2 groups (RFC 4291 §2.2
  // form 3 — includes IPv4-compatible `::1.2.3.4`, IPv4-mapped
  // `::ffff:1.2.3.4`, and NAT64 `64:ff9b::1.2.3.4`). #963: all of them
  // embed a real IPv4 target and must classify as that target.
  const ipv4TailMatch = address.match(
    /^(.+):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (ipv4TailMatch) {
    const octets = parseIPv4(ipv4TailMatch[2]);
    if (!octets) return undefined;
    const head = parseIPv6Head(ipv4TailMatch[1]);
    if (!head || head.some(Number.isNaN) || head.length !== 6) return undefined;
    return [
      ...head,
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
 * Parse the head (first 6 groups) of an IPv6 address that ends in an IPv4
 * dotted-quad. An explicit `::` compression must appear (the tail carries
 * the last 2 groups) and the head must resolve to exactly 6 groups.
 */
function parseIPv6Head(head: string): number[] | undefined {
  // The tail regex consumed one ':' of the address; a head ending in ':'
  // (e.g. '64:ff9b:' in '64:ff9b::1.2.3.4', or ':' in '::1.2.3.4') owns
  // the first half of the '::' compression — strip it so the remainder
  // parses as the groups before '::'.
  if (head.endsWith(':')) {
    head = head.slice(0, -1);
  }

  const parts = head.split('::');
  if (parts.length > 2) return undefined;

  let leftParts: string[];
  let rightParts: string[];

  if (parts.length === 2) {
    leftParts = parts[0] ? parts[0].split(':') : [];
    rightParts = parts[1] ? parts[1].split(':') : [];
    const missingGroups = 6 - leftParts.length - rightParts.length;
    if (missingGroups < 1) return undefined;
    const middle = new Array(missingGroups).fill('0');
    return [...leftParts, ...middle, ...rightParts].map((part) => {
      const parsed = parseInt(part, 16);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff
        ? parsed
        : NaN;
    });
  }

  leftParts = head ? head.split(':') : [];
  if (leftParts.length > 6) return undefined;
  // The head is everything before the '::' compression that preceded the
  // IPv4 tail — pad the middle with zeros up to the six leading groups.
  const missing = 6 - leftParts.length;
  if (missing > 0) leftParts = [...leftParts, ...new Array(missing).fill('0')];
  return leftParts.map((part) => {
    const parsed = parseInt(part, 16);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff
      ? parsed
      : NaN;
  });
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
    // #963 — an embedded IPv4 target must classify as that target:
    // dotted-quad tails in any IPv6 form (::ffff:a.b.c.d mapped,
    // ::a.b.c.d compatible, 64:ff9b::a.b.c.d NAT64) and the equivalent
    // hex shorthand (::a00:1 = ::10.0.0.1) when the leading 96 bits
    // identify an IPv4-bearing form.
    const tailIsDottedQuad = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(
      normalized.split(':').pop() ?? '',
    );
    const embeddedIPv4: number[] | undefined =
      tailIsDottedQuad || ipv6Groups[5] === 0xffff
        ? [
            (ipv6Groups[6] >> 8) & 0xff,
            ipv6Groups[6] & 0xff,
            (ipv6Groups[7] >> 8) & 0xff,
            ipv6Groups[7] & 0xff,
          ]
        : // IPv4-compatible hex shorthand: leading 80 bits zero and the
          // address is otherwise none of the IPv6-special ranges.
          ipv6Groups.slice(0, 5).every((g) => g === 0) && ipv6Groups[6] !== 0
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
      (embeddedIPv4 !== undefined &&
        (isPrivateIPv4(embeddedIPv4) ||
          isLoopbackIPv4(embeddedIPv4) ||
          isLinkLocalIPv4(embeddedIPv4)))
    );
  }

  return false;
}
