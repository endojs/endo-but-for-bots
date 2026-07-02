// event-mode.staging.test.cjs — P6 (LAN event mode / AUDIT INC-4).
//
// Proves the opt-in EVENT_MODE end-to-end on an ISOLATED server (ephemeral port + mkdtemp stores; NEVER the
// live :8778, never the real root.swiss) — exactly the T-TEST-1 discipline. Two spawns:
//
//   EVENT_MODE=1  → (1) also binds this host's LAN address, (2) mints share/#cap links at the LAN origin,
//                   (3) serves HTTPS with a freshly-generated self-signed cert (the getUserMedia secure
//                   context for a camp LAN).
//   EVENT_MODE off → plain HTTP, tailnet-default share origin, NO cert dir — i.e. today's behavior, unchanged.
//
// We can't reuse startIsolatedServer's HTTP health-check for the EVENT_MODE spawn (the server is HTTPS then),
// so we spawn directly here, reusing the harness's freePort. Cap-hygiene: we read the root cap from the
// sandbox SEED_FILE and ONLY ever assert `.startsWith(origin)` on minted links — a swissnum is never printed.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { X509Certificate } = require('node:crypto');

const { freePort } = require('./test-harness.cjs');
const SERVER = path.join(__dirname, 'server.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A present, RFC-1918 LAN address on THIS host — the deterministic LAN IP the test pins for origin + bind.
function firstPrivateLan() {
  const isPriv = ip => {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return false;
    const [a, b] = p;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  };
  for (const arr of Object.values(os.networkInterfaces())) {
    for (const i of arr || []) {
      if (i && !i.internal && (i.family === 'IPv4' || i.family === 4) && isPriv(i.address)) return i.address;
    }
  }
  return '';
}

// GET that tolerates a self-signed cert; resolves { status } (body discarded — may carry a cap).
function get(url) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { rejectUnauthorized: false }, res => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// POST JSON, tolerate self-signed; resolve parsed { status, json }.
function postJson(url, obj) {
  const lib = url.startsWith('https:') ? https : http;
  const data = Buffer.from(JSON.stringify(obj));
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
      rejectUnauthorized: false,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

// Fetch the peer cert the HTTPS listener actually presents (proves the self-signed cert is really in use).
function peerCert(host, port) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c);
    });
    s.on('error', reject);
    s.setTimeout(4000, () => s.destroy(new Error('timeout')));
  });
}

/** Spawn an isolated server with the given extra env; capture stderr; return handle. */
async function spawnServer(extraEnv, { https: wantHttps } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'va-event-'));
  const at = sub => path.join(tmp, sub);
  const config = at('config');
  fs.mkdirSync(config, { recursive: true });
  const seedFile = path.join(config, 'root.swiss');
  const port = await freePort();
  const env = {
    ...process.env,
    // isolation (mirror test-harness.cjs seams)
    FIELD_MODE: 'personal',
    PRINT_ROOT_CAP: '', // keep the full cap link OUT of the captured stderr (cap-hygiene)
    FIELD_CONFIG_DIR: config,
    FIELD_STATE_DIR: at('state'),
    VOICE_STATE_DIR: at('voice'),
    DASH_STATE_DIR: at('dash'),
    OBSIDIAN_VAULT: at('vault'),
    FIELD_HOME_BASE: at('home'),
    SEED_FILE: seedFile,
    OUT_DIR: at('out'),
    FORKS_STORE: path.join(at('voice'), 'forks.json'),
    PORT: String(port),
    // drop the tailnet candidate from the bind default so the test only considers loopback + (EVENT) LAN.
    BIND_DEFAULT: '127.0.0.1',
    // NOTE: PUBLIC_BASE_URL deliberately UNSET so BASE_URL is DERIVED (event origin vs tailnet default).
    ...extraEnv,
  };
  delete env.PUBLIC_BASE_URL;
  delete env.BIND; // never pin BIND — we exercise the EVENT_MODE candidate/self-heal path
  let stderr = '';
  const child = spawn('node', [SERVER], { cwd: __dirname, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });
  const scheme = wantHttps ? 'https' : 'http';
  const base = `${scheme}://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { const r = await get(`${base}/`); if (r.status === 200 || r.status === 404) { up = true; break; } } catch {}
    await sleep(250);
  }
  const close = () => { try { child.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  if (!up) { const tail = stderr.slice(-600); close(); throw new Error(`server failed to boot (${scheme}); stderr tail:\n${tail}`); }
  let cap = '';
  for (let i = 0; i < 40 && !cap; i++) { try { cap = fs.readFileSync(seedFile, 'utf8').trim(); } catch {} if (!cap) await sleep(100); }
  return { child, port, base, tmp, config, seedFile, cap, getStderr: () => stderr, close };
}

test('EVENT_MODE=1: LAN bind + LAN https share-origin + generated self-signed cert', async t => {
  const lan = firstPrivateLan();
  if (!lan) { t.skip('no RFC-1918 LAN address present on this host'); return; }
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cert-'));
  const srv = await spawnServer({ EVENT_MODE: '1', EVENT_LAN_IP: lan, EVENT_CERT_DIR: certDir }, { https: true });
  t.after(() => { srv.close(); try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {} });

  const logs = srv.getStderr();
  // (3) HTTPS on loopback AND (1) HTTPS on the LAN address — the boot log proves scheme + both binds.
  assert.match(logs, new RegExp(`field agent on https://127\\.0\\.0\\.1:${srv.port}`), 'should serve HTTPS on loopback');
  assert.match(logs, new RegExp(`field agent on https://${lan.replace(/\./g, '\\.')}:${srv.port}`), 'should ALSO bind+serve HTTPS on the LAN address');

  // (1) the LAN listener is actually reachable over TLS.
  const lanResp = await get(`https://${lan}:${srv.port}/`);
  assert.ok(lanResp.status === 200 || lanResp.status === 404, 'LAN address reachable over HTTPS');

  // (3) the cert was generated at the field-config cert path and covers the LAN IP in its SAN.
  const certPem = fs.readFileSync(path.join(certDir, 'cert.pem'), 'utf8');
  assert.ok(fs.existsSync(path.join(certDir, 'key.pem')), 'key.pem generated');
  const san = new X509Certificate(certPem).subjectAltName || '';
  assert.ok(san.includes(`IP Address:${lan}`), `cert SAN covers LAN IP (${san})`);

  // (3) the HTTPS listener really presents that self-signed cert (fingerprint matches the generated file).
  const presented = await peerCert('127.0.0.1', srv.port);
  const genFp = new X509Certificate(certPem).fingerprint256;
  assert.equal(presented.fingerprint256, genFp, 'listener presents the generated self-signed cert');
  assert.ok(String(presented.subjectaltname || '').includes(`IP Address:${lan}`), 'presented cert SAN covers the LAN IP');

  // (2) a minted app-share link carries the LAN HTTPS origin (never print the swissnum-bearing url).
  assert.ok(srv.cap, 'root cap materialized from SEED_FILE');
  const share = await postJson(`https://127.0.0.1:${srv.port}/apps/share`, { cap: srv.cap, app: 'file-browser', roots: ['vault'] });
  assert.equal(share.status, 200, 'apps/share ok');
  assert.ok(typeof share.json.url === 'string' && share.json.url.startsWith(`https://${lan}:${srv.port}/apps/file-browser`),
    'share link uses the LAN https origin');
});

test('EVENT_MODE off: plain HTTP, tailnet-default share origin, no cert — behavior unchanged', async t => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cert-off-'));
  // EVENT_MODE unset. EVENT_CERT_DIR pointed at an empty temp so we can prove NOTHING gets written there.
  const srv = await spawnServer({ EVENT_CERT_DIR: certDir }, { https: false });
  t.after(() => { srv.close(); try { fs.rmSync(certDir, { recursive: true, force: true }); } catch {} });

  const logs = srv.getStderr();
  assert.match(logs, new RegExp(`field agent on http://127\\.0\\.0\\.1:${srv.port}`), 'serves plain HTTP (unchanged)');
  assert.ok(!/field agent on https:/.test(logs), 'no HTTPS listener when EVENT_MODE is off');

  // an HTTPS request to the HTTP port must fail (proves it is NOT a TLS listener).
  await assert.rejects(get(`https://127.0.0.1:${srv.port}/`), 'https to an http listener fails');

  // no cert generated when EVENT_MODE is off.
  assert.ok(!fs.existsSync(path.join(certDir, 'cert.pem')), 'no self-signed cert generated off-mode');

  // BASE_URL falls to the tailnet default (PUBLIC_BASE_URL unset, EVENT off) — share origin is UNCHANGED.
  assert.ok(srv.cap, 'root cap materialized');
  const share = await postJson(`http://127.0.0.1:${srv.port}/apps/share`, { cap: srv.cap, app: 'file-browser', roots: ['vault'] });
  assert.equal(share.status, 200, 'apps/share ok');
  assert.ok(typeof share.json.url === 'string' && share.json.url.startsWith('http://100.83.80.102:'),
    'share link uses the unchanged tailnet-default http origin');
});
