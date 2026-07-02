// browser-run.test.mjs — SEC-9 companion: the `browser` power shells out to chromium,
// which does its OWN DNS resolution, so the advisory ssrfOk pre-check can be bypassed by
// a rebinding host. browser-run.cjs closes that by (i) refusing to launch chromium for a
// private/unresolvable top-level host, (ii) pinning the top-level host to the vetted IP via
// --host-resolver-rules, and (iii) aborting any request to a private host/IP at the route
// layer. This proves, against a fake resolver + a real chromium + loopback servers:
//   (a) a "public" URL renders (pinned-IP happy path works E2E),
//   (b) a hostname resolving to a private/loopback IP is refused BEFORE chromium launches,
//   (c) a redirect to a private host is blocked (chromium never returns the secret body),
//   (d) a literal private-IP top-level URL is refused before launch.
//
// Same loopback trick as ssrf.test.mjs: bind the "public" server to the loopback alias
// 127.0.0.2 and inject an isPrivateIp that treats ONLY 127.0.0.2 as public.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';

import { browserRun } from './browser-run.cjs';
import { makeSsrfGuard } from './ssrf.mjs';

const PUBLIC_IP = '127.0.0.2'; // stands in for a routable public address
const testIsPrivate = ip => ip !== PUBLIC_IP; // only the "public" alias is allowed
const CHROMIUM = process.env.FIELD_CHROMIUM || '/usr/bin/chromium';
const haveChromium = fs.existsSync(CHROMIUM);

const startServer = () =>
  new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redir-private') {
        res.writeHead(302, { location: `http://internal.test:${srv.address().port}/secret` });
        return res.end('redirecting');
      }
      if (req.url === '/secret') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('TOP-SECRET-INTERNAL-DATA');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`BODY-FOR ${req.headers.host}`);
    });
    srv.listen(0, PUBLIC_IP, () => resolve(srv));
  });

test('(a) a public URL renders over the pinned path', { skip: !haveChromium }, async () => {
  const srv = await startServer();
  const { port } = srv.address();
  try {
    const guard = makeSsrfGuard({
      // any host → the public alias. Real DNS cannot resolve "totally.made.up", so a
      // successful render proves chromium used OUR --host-resolver-rules pin.
      dnsLookup: async () => [{ address: PUBLIC_IP, family: 4 }],
      isPrivateIp: testIsPrivate,
    });
    const r = await browserRun({ cmd: 'visit', url: `http://totally.made.up:${port}/ok`, guard });
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    assert.match(r.text, /BODY-FOR totally\.made\.up:/); // Host header preserved, pinned to 127.0.0.2
  } finally {
    srv.close();
  }
});

test('(b) a hostname resolving to a private IP is refused BEFORE chromium launches', async () => {
  let launched = false;
  const spyChromium = {
    launch: async () => {
      launched = true;
      throw new Error('chromium must not launch for a blocked host');
    },
  };
  const guard = makeSsrfGuard({ dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  const r = await browserRun({ cmd: 'visit', url: 'http://evil.test/', guard, chromium: spyChromium });
  assert.equal(r.ok, false);
  assert.match(r.error, /blocked host/);
  assert.equal(launched, false, 'chromium was launched for a private host — pre-vet did not fail closed');
});

test('(c) a redirect to a private host is blocked (secret never fetched)', { skip: !haveChromium }, async () => {
  const srv = await startServer();
  const { port } = srv.address();
  try {
    const guard = makeSsrfGuard({
      // "good.test" → public alias; the redirect target "internal.test" → 127.0.0.1 (private)
      dnsLookup: async host => [host === 'good.test' ? { address: PUBLIC_IP, family: 4 } : { address: '127.0.0.1', family: 4 }],
      isPrivateIp: testIsPrivate,
    });
    const r = await browserRun({ cmd: 'visit', url: `http://good.test:${port}/redir-private`, guard });
    // The top-level hop is pinned + reached; the 302 to internal.test is aborted at the
    // route layer before it leaves, so navigation fails and the secret is never returned.
    assert.equal(r.ok, false, `redirect to private host should fail, got ${JSON.stringify(r)}`);
    assert.doesNotMatch(String(r.text || '') + String(r.error || ''), /TOP-SECRET-INTERNAL-DATA/);
  } finally {
    srv.close();
  }
});

test('(d) a literal private-IP top-level URL is refused before launch', async () => {
  let launched = false;
  const spyChromium = {
    launch: async () => {
      launched = true;
      throw new Error('chromium must not launch');
    },
  };
  // Default real-DNS guard: dns.lookup of a literal returns the literal, then the real
  // private-range check rejects it.
  const guard = makeSsrfGuard();
  const r = await browserRun({ cmd: 'visit', url: 'http://127.0.0.1:1/', guard, chromium: spyChromium });
  assert.equal(r.ok, false);
  assert.match(r.error, /blocked host/);
  assert.equal(launched, false);
});

test('non-http(s) top-level scheme is rejected', async () => {
  const r = await browserRun({ cmd: 'visit', url: 'file:///etc/passwd', guard: makeSsrfGuard() });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-http|invalid/);
});
