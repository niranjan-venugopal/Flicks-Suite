import { lookup as dnsLookupCb } from 'dns';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import type { LookupFunction } from 'net';

/**
 * SSRF guard for outbound webhooks (PRD v5 §11/§13). We resolve the target
 * host and refuse anything that lands in private, loopback, link-local, or
 * otherwise non-public address space — checked BOTH at endpoint registration
 * and immediately before every delivery (DNS can change between the two).
 */

function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata!)
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

/** Pull an embedded IPv4 out of ::ffff:a.b.c.d, ::a.b.c.d, or 64:ff9b::a.b.c.d. */
function embeddedV4(lower: string): string | null {
  // Dotted-quad tail (IPv4-mapped / IPv4-compatible / NAT64 well-known prefix).
  const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
  if (dotted && isIP(dotted[1]!) === 4) return dotted[1]!;
  // NAT64 64:ff9b::/96 with a hex-encoded v4 tail, e.g. 64:ff9b::7f00:1.
  if (lower.startsWith('64:ff9b::')) {
    const tail = lower.slice('64:ff9b::'.length).split(':');
    if (tail.length === 2 && /^[0-9a-f]{1,4}$/.test(tail[0]!) && /^[0-9a-f]{1,4}$/.test(tail[1]!)) {
      const hi = parseInt(tail[0]!, 16);
      const lo = parseInt(tail[1]!, 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const ip = ipv4ToInt(addr);
    return PRIVATE_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
      return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    // Any embedded IPv4 (mapped, compatible, or NAT64) → evaluate the v4.
    const v4 = embeddedV4(lower);
    if (v4) return isPrivateAddress(v4);
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

export class SsrfViolationError extends Error {}

/**
 * Validate a webhook URL: http(s) only (https required in production),
 * resolve every A/AAAA answer and reject if ANY lands in private space.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfViolationError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfViolationError('Only http(s) URLs are allowed');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new SsrfViolationError('Webhook URLs must use https');
  }
  if (url.username || url.password) {
    throw new SsrfViolationError('Credentials in webhook URLs are not allowed');
  }
  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new SsrfViolationError('Webhook host resolves to a private address');
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfViolationError('Webhook host does not resolve');
  }
  if (addrs.length === 0) {
    throw new SsrfViolationError('Webhook host does not resolve');
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new SsrfViolationError('Webhook host resolves to a private address');
    }
  }
}

/**
 * A DNS lookup that validates AND pins at CONNECT time. Node calls this the
 * moment it opens the socket, and connects to exactly the address it returns —
 * so unlike a separate pre-flight resolve, there is no rebinding window: the
 * address we validate IS the address we connect to. Any private answer aborts
 * the connection. The hostname is preserved for TLS SNI/cert validation.
 */
const pinnedSecureLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      return callback(new SsrfViolationError('host does not resolve'), '', 0);
    }
    for (const a of list) {
      if (isPrivateAddress(a.address)) {
        return callback(
          new SsrfViolationError('host resolves to a private address'),
          '',
          0,
        );
      }
    }
    const first = list[0]!;
    // `options.all` is honored by the caller in some Node paths; return the
    // shape it asked for.
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: unknown, a: unknown) => void)(null, list);
    }
    return callback(null, first.address, first.family);
  });
};

export interface SsrfSafePostResult {
  status: number;
}

/**
 * POST JSON to an external URL with SSRF protection enforced at connection
 * time (webhook delivery, PRD v5 §11). Uses node http/https with the pinned
 * lookup above, a hard timeout, and NO redirect following (a 3xx could
 * re-target into private space). Throws SsrfViolationError if the host
 * resolves private; other network errors reject normally.
 */
export function ssrfSafePostJson(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<SsrfSafePostResult> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      url,
      {
        method: 'POST',
        lookup: pinnedSecureLookup,
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // A redirect could bounce us to an internal target — refuse to follow.
        if (status >= 300 && status < 400) {
          res.destroy();
          return reject(new SsrfViolationError('Webhook endpoint returned a redirect'));
        }
        res.on('data', () => undefined); // drain
        res.on('end', () => resolve({ status }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Webhook request timed out')));
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}
