// grunt.mjs — the deployable entry point. `import '@endo/init'` FIRST (SES lockdown), then wire the injected
// providers into the pipeline, wrap it in the cap layer (makeDietician), and expose it over an HTTP/JSON /rpc
// adapter + a static SPA, with a persisted root swissnum so the owner's link survives restarts. Bind
// loopback+tailnet by default; public chu-bind is an explicit per-instance operator step (Slice 11), never a
// default. The Google + Anthropic keys live in the providers (read from the secret registry), never in a cap.
//
//   DIET_PERSON   (default 'alexa')   — which instance to serve
//   DIET_PORT     (default 8782)
//   DIET_BIND     (comma IPs; default 127.0.0.1)   DIET_BASE_URL (default http://127.0.0.1:<port>)
//   DIET_ROOT_DIR (default ~/.local/state/dietician-app/instances/<person>)
import '@endo/init';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { E } = await import('@endo/far');
const { makeFsFolder } = await import('./fs-folder.mjs');
const { makeDietStore } = await import('./store.mjs');
const { makePipeline } = await import('./core.mjs');
const places = await import('./providers/places.mjs');
const { makeJudge } = await import('./providers/judge.mjs');
const { makeAnthropicComplete } = await import('./providers/anthropic.mjs');
const { makeDietician, newSwiss } = await import('./console.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PERSON = process.env.DIET_PERSON || 'alexa';
const PORT = Number(process.env.DIET_PORT || 8782);
const BIND = (process.env.DIET_BIND || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean);
const BASE_URL = process.env.DIET_BASE_URL || `http://127.0.0.1:${PORT}`;
const ROOT_DIR = process.env.DIET_ROOT_DIR || path.join(HOME, '.local/state/dietician-app/instances', PERSON);
const SEED_FILE = path.join(HOME, '.config/dietician-app', `${PERSON}.swiss`);

const log = (...a) => process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`);

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'interest-cohort=(), browsing-topics=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
};

const readBody = req => new Promise(resolve => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 2 * 1024 * 1024) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  req.on('error', () => resolve({}));
});

const serveFile = async (res, rel, type) => {
  try {
    const buf = await fsp.readFile(path.join(HERE, 'public', rel));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...SEC_HEADERS });
    res.end(buf);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
};

const main = async () => {
  // stable root swissnum (so the owner's link survives restarts)
  let rootSwiss = '';
  try { rootSwiss = (await fsp.readFile(SEED_FILE, 'utf8')).trim(); } catch { /* mint */ }
  if (!/^[0-9a-f]{32}$/.test(rootSwiss)) {
    rootSwiss = newSwiss();
    await fsp.mkdir(path.dirname(SEED_FILE), { recursive: true });
    await fsp.writeFile(SEED_FILE, rootSwiss, { mode: 0o600 });
  }

  const store = makeDietStore(makeFsFolder(ROOT_DIR), { person: PERSON });
  const judge = makeJudge({ complete: makeAnthropicComplete() });
  const pipeline = makePipeline({ store, places, judge, person: PERSON, baseUrl: BASE_URL });
  const { locator } = makeDietician({ pipeline, store, baseUrl: BASE_URL, person: PERSON, rootSwiss });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, BASE_URL);
      const { pathname } = url;
      if (pathname === '/' || pathname === '/index.html') return serveFile(res, 'index.html', 'text/html; charset=utf-8');
      if (pathname === '/app.js') return serveFile(res, 'app.js', 'text/javascript; charset=utf-8');

      if (req.method === 'POST' && pathname === '/rpc') {
        const { swissnum, method, args = [] } = await readBody(req);
        const entry = locator.get(String(swissnum || ''));
        if (!entry) { res.writeHead(404, { 'content-type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify({ ok: false, error: 'unknown or revoked capability' })); return; }
        try {
          const result = await E(entry.cap)[method](...(Array.isArray(args) ? args : []));
          res.writeHead(200, { 'content-type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify({ ok: true, result }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json', ...SEC_HEADERS }); res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain', ...SEC_HEADERS }); res.end('not found');
    } catch (e) { if (!res.headersSent) res.writeHead(500); res.end('error'); log('handler error', e && e.message); }
  };

  for (const ip of BIND) {
    const s = http.createServer(handler);
    s.on('error', e => log(`bind ${ip} failed:`, e.message));
    s.listen(PORT, ip, () => log(`listening http://${ip}:${PORT}  (person=${PERSON}, dir=${ROOT_DIR})`));
  }
  // The owner link is the root swissnum. Logged ONLY when explicitly asked (avoid leaking it to shared logs).
  if (process.env.DIET_PRINT_ROOT === '1') log(`ROOT LINK: ${BASE_URL}/#cap=${rootSwiss}`);
  else log(`root cap ready (fp ${rootSwiss.slice(0, 6)}…; set DIET_PRINT_ROOT=1 to print the full link)`);
};

main().catch(e => { log('FATAL', (e && e.stack) || e); process.exit(1); });
