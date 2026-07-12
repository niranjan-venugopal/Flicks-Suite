import { lookup } from 'dns/promises';
import { isIP } from 'net';

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

export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const ip = ipv4ToInt(addr);
    return PRIVATE_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    // Normalize the unambiguous prefixes we refuse outright.
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
      return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped — evaluate the embedded v4.
      const v4 = lower.slice('::ffff:'.length);
      return isIP(v4) === 4 ? isPrivateAddress(v4) : true;
    }
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
