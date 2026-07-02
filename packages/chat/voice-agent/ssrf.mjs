// ssrf.mjs — SSRF egress guard that is DNS-rebinding (TOCTOU) proof.
//
// The old guard did a `dns.lookup` check and then let `fetch` re-resolve the
// hostname independently. A rebinding host could answer PUBLIC to the check and
// PRIVATE to the actual dial (or on `redirect:'follow'`, hop to a private host
// that was never vetted). This module closes the gap by PINNING: it resolves the
// host once, asserts EVERY resolved address is public, and then dials that exact
// IP (via a custom `lookup` handed to node:http/https) — the socket goes to the
// address that was checked, never a re-resolved one. Redirects are followed
// MANUALLY, re-vetting + re-pinning every hop.
//
// Deps are injectable (`dnsLookup`, `isPrivateIp`, http/https modules) so the
// guard can be exercised against a fake resolver in tests without real DNS.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';

// harden is a global after @endo/init lockdown; degrade to identity for bare
// `node --test` imports of this module.
const h = globalThis.harden || (x => x);

// Reject anything that is not a routable public address: loopback, RFC1918,
// link-local, CGNAT-adjacent, multicast/reserved, and their IPv6 forms /
// v4-mapped forms. Unparseable → treated as private (fail closed).
export const isPrivateIp = ip => {
  if (typeof ip !== 'string' || ip === '') return true;
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    // v4-mapped IPv6 (::ffff:a.b.c.d): judge the embedded v4 address.
    const m = l.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return isPrivateIp(m[1]);
    return (
      l === '::1' ||
      l === '::' ||
      l.startsWith('fc') ||
      l.startsWith('fd') || // unique-local
      l.startsWith('fe80') || // link-local
      l.startsWith('fe9') ||
      l.startsWith('fea') ||
      l.startsWith('feb') || // link-local range feature
      l.startsWith('ff') // multicast
    );
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast + reserved
  );
};
h(isPrivateIp);

/**
 * @param {object} [deps]
 * @param {(host: string, opts: object) => Promise<Array<{address: string, family: number}>>} [deps.dnsLookup]
 * @param {(ip: string) => boolean} [deps.isPrivateIp]
 * @param {typeof http} [deps.httpMod]
 * @param {typeof https} [deps.httpsMod]
 */
export const makeSsrfGuard = ({
  dnsLookup = (host, opts) => dns.lookup(host, opts),
  isPrivateIp: isPriv = isPrivateIp,
  httpMod = http,
  httpsMod = https,
} = {}) => {
  // Resolve a hostname and assert EVERY resolved address is public. Returns the
  // vetted address list so the caller can PIN the connection to exactly these IPs.
  const resolveVetted = async hostname => {
    let recs;
    try {
      recs = await dnsLookup(hostname, { all: true });
    } catch {
      return { ok: false, error: 'dns resolution failed' };
    }
    if (!Array.isArray(recs) || recs.length === 0) return { ok: false, error: 'dns: no records' };
    if (recs.some(r => isPriv(r.address))) {
      return { ok: false, error: 'blocked host (private/loopback/link-local)' };
    }
    return { ok: true, addrs: recs.map(r => ({ address: r.address, family: r.family })) };
  };

  // Boolean advisory check (kept for callers that only want a yes/no gate, e.g.
  // the out-of-process browser worker + connectors). NOT sufficient on its own —
  // `safeFetch` is the enforcing, pin-authoritative path.
  const ssrfOk = async u => {
    let url;
    try {
      url = new URL(u);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(url.protocol)) return false;
    return (await resolveVetted(url.hostname)).ok;
  };

  // SSRF-hardened HTTP(S) fetch with the resolved IP PINNED onto the socket.
  // Follows redirects manually, re-vetting + re-pinning every hop. Reads the full
  // body (capped at maxBytes → rejects 'too large'). Resolves to a minimal
  // fetch-Response-like value: { ok, status, url, headers.get(), buffer, text() }.
  const safeFetch = (
    urlStr,
    { method = 'GET', headers = {}, body, timeoutMs = 12000, maxBytes = 8 * 1024 * 1024, maxRedirects = 5 } = {},
  ) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (!settled) {
          settled = true;
          fn(v);
        }
      };
      const step = async (current, redirectsLeft) => {
        let url;
        try {
          url = new URL(current);
        } catch {
          return finish(reject, new Error('invalid url'));
        }
        if (!/^https?:$/.test(url.protocol)) return finish(reject, new Error('blocked/invalid url'));
        const vetted = await resolveVetted(url.hostname);
        if (!vetted.ok) return finish(reject, new Error(vetted.error));
        // The pin: return ONLY the vetted addresses; node:net connects to these,
        // never re-resolving the name. Host header + TLS SNI stay the hostname.
        const lookup = (_hn, opts, cb) => {
          if (opts && opts.all) return cb(null, vetted.addrs);
          const a = vetted.addrs[0];
          return cb(null, a.address, a.family);
        };
        const mod = url.protocol === 'https:' ? httpsMod : httpMod;
        let req;
        try {
          req = mod.request(
            {
              protocol: url.protocol,
              hostname: url.hostname,
              port: url.port || (url.protocol === 'https:' ? 443 : 80),
              path: url.pathname + url.search,
              method,
              headers,
              lookup,
              timeout: timeoutMs,
            },
            res => {
              const status = res.statusCode || 0;
              const loc = res.headers.location;
              if ([301, 302, 303, 307, 308].includes(status) && loc) {
                res.resume(); // drain the redirect body
                if (redirectsLeft <= 0) return finish(reject, new Error('too many redirects'));
                let next;
                try {
                  next = new URL(loc, url.toString()).toString();
                } catch {
                  return finish(reject, new Error('bad redirect location'));
                }
                step(next, redirectsLeft - 1);
                return;
              }
              const chunks = [];
              let total = 0;
              res.on('data', c => {
                total += c.length;
                if (total > maxBytes) {
                  res.destroy();
                  return finish(reject, new Error('too large'));
                }
                chunks.push(c);
              });
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const hdrs = res.headers;
                finish(resolve, {
                  ok: status >= 200 && status < 300,
                  status,
                  url: url.toString(),
                  headers: {
                    get: k => {
                      const v = hdrs[String(k).toLowerCase()];
                      return Array.isArray(v) ? v.join(', ') : v ?? null;
                    },
                  },
                  buffer: buf,
                  async text() {
                    return buf.toString('utf8');
                  },
                });
              });
              res.on('error', e => finish(reject, e));
            },
          );
        } catch (e) {
          return finish(reject, e instanceof Error ? e : new Error(String(e)));
        }
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', e => finish(reject, e));
        if (body !== undefined && body !== null) req.write(body);
        req.end();
      };
      step(urlStr, maxRedirects).catch(e => finish(reject, e instanceof Error ? e : new Error(String(e))));
    });

  return h({ resolveVetted, ssrfOk, safeFetch });
};
h(makeSsrfGuard);

// Default guard wired to real DNS — what agent-caps.mjs imports.
export const ssrfGuard = makeSsrfGuard();
h(ssrfGuard);
