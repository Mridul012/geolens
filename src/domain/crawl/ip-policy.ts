/**
 * IP address policy — pure, and the heart of SSRF defence (Engineering-Rules §12).
 *
 * We fetch arbitrary user-supplied URLs from inside our own network, which is the classic
 * server-side request forgery setup. This module answers one question: may we connect to
 * this address? It is deliberately conservative — a false negative costs a user one clear
 * error message, a false positive points our crawler at somebody's internal network.
 *
 * Kept separate from URL parsing because the guard must re-ask it about every *resolved*
 * address, not just the hostname the user typed (DNS rebinding).
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  readonly version: IpVersion;
  /** Octets for v4; 8 sixteen-bit groups for v6. */
  readonly parts: readonly number[];
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIpv4(value: string): ParsedIp | null {
  const match = IPV4_PATTERN.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((octet) => octet > 255)) return null;
  // Reject zero-padded forms: "010.0.0.1" is octal to some resolvers and decimal to others.
  if (match.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) return null;
  return { version: 4, parts };
}

/** Expands `::` and IPv4-mapped tails into eight 16-bit groups. */
export function parseIpv6(value: string): ParsedIp | null {
  const address = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return null;
  // Zone identifiers ("fe80::1%eth0") are never valid in a URL host we would fetch.
  if (address.includes("%")) return null;

  const [head = "", tail, ...rest] = address.split("::");
  if (rest.length > 0) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment.length === 0) return [];
    const groups: number[] = [];
    for (const raw of segment.split(":")) {
      if (raw.length === 0) return null;
      // An embedded IPv4 tail ("::ffff:127.0.0.1") contributes two groups.
      const asV4 = parseIpv4(raw);
      if (asV4 !== null) {
        const [a = 0, b = 0, c = 0, d = 0] = asV4.parts;
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(raw)) return null;
      groups.push(Number.parseInt(raw, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  if (headGroups === null) return null;

  if (tail === undefined) {
    return headGroups.length === 8 ? { version: 6, parts: headGroups } : null;
  }

  const tailGroups = parseGroups(tail);
  if (tailGroups === null) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return {
    version: 6,
    parts: [...headGroups, ...Array.from({ length: missing }, () => 0), ...tailGroups],
  };
}

export function parseIp(value: string): ParsedIp | null {
  return parseIpv4(value) ?? parseIpv6(value);
}

function isBlockedV4(parts: readonly number[]): boolean {
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedV6(parts: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = parts;

  if (parts.every((group) => group === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true; // ::1 loopback
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge by the embedded v4 address, or
  // an attacker tunnels straight through the v4 rules.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    const embedded = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
    return isBlockedV4(embedded);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation prefix
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64 — resolves to a v4 target
  return false;
}

/**
 * True when we may open a connection to this address.
 *
 * @param value A literal IP address. Hostnames must be resolved first — this function
 * never performs DNS, because the guard has to call it once per resolved address.
 */
export function isPubliclyRoutableIp(value: string): boolean {
  const parsed = parseIp(value);
  if (parsed === null) return false;
  return parsed.version === 4 ? !isBlockedV4(parsed.parts) : !isBlockedV6(parsed.parts);
}
