import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Fetch a user-supplied URL safely: https only, hostname resolved first and rejected when it points at a private,
 * loopback, link-local or metadata address, no redirects, and the body read as a stream with a hard byte cap so a
 * chunked response can never exhaust memory before a size check.
 */
const PRIVATE_V4 = [
  [/^0\./], [/^10\./], [/^127\./], [/^169\.254\./], [/^192\.168\./], [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./],
  [/^172\.(1[6-9]|2\d|3[01])\./], [/^22[4-9]\.|^2[3-5]\d\./],
];
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some(([re]) => re.test(ip));
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd|fe[89ab])/.test(v6);
}

export class UnsafeUrlError extends Error {}

export async function safeFetchBytes(rawUrl: string, opts: { maxBytes: number; timeoutMs?: number; accept?: string }): Promise<Buffer> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new UnsafeUrlError('That is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('Only https URLs are accepted.');
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not accepted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new UnsafeUrlError('That host is not reachable from here.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new UnsafeUrlError('That host could not be resolved.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('That host is not reachable from here.');

  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: opts.accept ?? '*/*', 'user-agent': 'LantleBot/1.0 (+https://lantle.ai)' } }).catch(() => null);
  if (!res || !res.ok || !res.body) throw new UnsafeUrlError('The URL could not be fetched.');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > opts.maxBytes) throw new UnsafeUrlError('That file is too large.');
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) { await reader.cancel().catch(() => undefined); throw new UnsafeUrlError('That file is too large.'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
