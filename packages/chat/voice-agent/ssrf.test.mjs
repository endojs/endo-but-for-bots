// ssrf.test.mjs — SEC-9: DNS-rebinding / TOCTOU SSRF guard (ssrf.mjs).
//
// Proves, against a fake resolver + real loopback servers (no real DNS):
//   (a) a "public" URL still fetches (the pinned-IP happy path works E2E),
//   (b) a hostname resolving to a private/loopback IP is refused,
//   (c) a redirect to a private host is refused (every hop re-vetted),
//   (d) a host that answers PUBLIC to the advisory check then PRIVATE to the
//       enforcing fetch (classic rebinding) cannot slip through — safeFetch's
//       own pinned resolution is authoritative.
//
// The trick that makes this testable on a loopback-only box: we bind the
// "public" server to the loopback alias 127.0.0.2 and inject an isPrivateIp that
// treats ONLY 127.0.0.2 as public. Everything else (incl. 127.0.0.1) is private.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { makeSsrfGuard, isPrivateIp } from './ssrf.mjs';

const PUBLIC_IP = '127.0.0.2'; // stands in for a routable public address in these tests
const testIsPrivate = ip => ip !== PUBLIC_IP; // only the "public" alias is allowed

// A server bound to the public alias. /ok → 200 body; /redir-private → 302 to a
// host the fake resolver maps to 127.0.0.1 (private).
const startServer = () =>
  new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redir-private') {
        // redirect to the same port on a host the fake resolver maps to private
        res.writeHead(302, { location: `http://internal.test:${srv.address().port}/secret` });
        return res.end('redirecting');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`BODY-FOR ${req.headers.host}`);
    });
    srv.listen(0, PUBLIC_IP, () => resolve(srv));
  });

test('isPrivateIp table: blocks loopback/LAN/link-local/CGNAT/v4-mapped, allows public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1', '0.0.0.0']) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

test('(a) a public URL fetches over the pinned path', async () => {
  const srv = await startServer();
  const { port } = srv.address();
  try {
    const guard = makeSsrfGuard({
      // fake resolver: any host → the public alias. Proves the socket used OUR
      // pinned lookup (real DNS cannot resolve "totally.made.up").
      dnsLookup: async () => [{ address: PUBLIC_IP, family: 4 }],
      isPrivateIp: testIsPrivate,
    });
    const res = await guard.safeFetch(`http://totally.made.up:${port}/ok`);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /BODY-FOR totally\.made\.up:/); // Host header preserved
  } finally {
    srv.close();
  }
});

test('(b) a hostname resolving to a private/loopback IP is refused', async () => {
  const guard = makeSsrfGuard({
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    // real isPrivateIp
  });
  assert.equal(await guard.ssrfOk('http://evil.test/'), false);
  await assert.rejects(guard.safeFetch('http://evil.test/'), /blocked host/);
});

test('(b2) a mixed answer (one public, one private) is refused — fail closed on ANY private', async () => {
  const guard = makeSsrfGuard({
    dnsLookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  });
  assert.equal(await guard.ssrfOk('http://sneaky.test/'), false);
  await assert.rejects(guard.safeFetch('http://sneaky.test/'), /blocked host/);
});

test('(c) a redirect to a private host is refused (each hop re-vetted + re-pinned)', async () => {
  const srv = await startServer();
  const { port } = srv.address();
  try {
    const guard = makeSsrfGuard({
      // "good.test" → public alias; anything else (the redirect target
      // "internal.test") → 127.0.0.1 (private).
      dnsLookup: async host => [host === 'good.test' ? { address: PUBLIC_IP, family: 4 } : { address: '127.0.0.1', family: 4 }],
      isPrivateIp: testIsPrivate,
    });
    // First hop (good.test → public) is allowed and reached; it 302s to
    // internal.test which resolves private → the follow must be refused.
    await assert.rejects(guard.safeFetch(`http://good.test:${port}/redir-private`), /blocked host/);
  } finally {
    srv.close();
  }
});

test('(d) rebinding: public to the check, private to the fetch — cannot slip through', async () => {
  const srv = await startServer();
  const { port } = srv.address();
  try {
    // Resolver flips answer across calls: 1st lookup public, 2nd lookup private.
    let calls = 0;
    const guard = makeSsrfGuard({
      dnsLookup: async () => {
        calls += 1;
        return [calls === 1 ? { address: PUBLIC_IP, family: 4 } : { address: '127.0.0.1', family: 4 }];
      },
      isPrivateIp: testIsPrivate,
    });
    // Advisory check (lookup #1) passes...
    assert.equal(await guard.ssrfOk(`http://rebind.test:${port}/ok`), true);
    // ...but the enforcing fetch does its OWN authoritative resolution (lookup #2,
    // now private) and pins to that — so it refuses. The check is not trusted.
    await assert.rejects(guard.safeFetch(`http://rebind.test:${port}/ok`), /blocked host/);
    assert.equal(calls, 2);
  } finally {
    srv.close();
  }
});

test('non-http(s) schemes are rejected', async () => {
  const guard = makeSsrfGuard({ dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  assert.equal(await guard.ssrfOk('file:///etc/passwd'), false);
  assert.equal(await guard.ssrfOk('ftp://example.com/'), false);
  await assert.rejects(guard.safeFetch('gopher://example.com/'), /blocked\/invalid url/);
});

test('maxBytes cap is enforced', async () => {
  const srv = await new Promise(resolve => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(50_000));
    });
    s.listen(0, PUBLIC_IP, () => resolve(s));
  });
  const { port } = srv.address();
  try {
    const guard = makeSsrfGuard({ dnsLookup: async () => [{ address: PUBLIC_IP, family: 4 }], isPrivateIp: testIsPrivate });
    await assert.rejects(guard.safeFetch(`http://big.test:${port}/`, { maxBytes: 1000 }), /too large/);
  } finally {
    srv.close();
  }
});
