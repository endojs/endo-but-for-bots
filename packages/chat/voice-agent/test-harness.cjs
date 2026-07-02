// test-harness.cjs — the shared staging-test harness. ONE way to spawn an ISOLATED
// voice-agent server for a staging test, so no test ever reads/mutates the LIVE :8778
// service's real forks.json / chats / purse / feed / backlog.
//
// Why this exists (AUDIT-WORKLIST T-TEST-1 / T-TEST-2 / P2-6):
//   • T-TEST-1 — ~24 staging tests navigated to http://127.0.0.1:8778 and read the real
//     root cap from ~/.config/field-agent/root.swiss. Running `npm test` (which is
//     `node --test`, and DISCOVERS *.staging.test.cjs because the basename contains
//     `.test.`) on the live box therefore drove — and corrupted — real state.
//   • T-TEST-2 — the tests that DID spawn a server used FIXED ports (8783-8866, many
//     colliding: 8796×5, 8797×5, 8798×4) → EADDRINUSE / cross-talk under parallel runs.
//   • P2-6 — spawned servers were orphaned on SIGINT/SIGTERM (no signal handler).
//
// startIsolatedServer():
//   (a) picks a genuinely-free EPHEMERAL port (net.listen(0) probe — NOT port 0 passed to
//       the server: server.mjs does `Number(process.env.PORT) || 8778` and 0 is falsy, so
//       it would silently fall back to the LIVE port; the documented Endo port-0 gotcha),
//   (b) points every store at an `mkdtemp` sandbox via the env seams the server already
//       honors — FIELD_CONFIG_DIR / FIELD_STATE_DIR / VOICE_STATE_DIR / DASH_STATE_DIR
//       (from field-config.mjs) plus SEED_FILE / FORKS_STORE / OUT_DIR / … . Nearly every
//       store (chats, forks, purses, feed, backlog, seed-chats, component-git, memo,
//       tool-shares, app-shares, asks) derives from those four dirs, so this fully isolates
//       with a handful of vars,
//   (c) installs process exit + SIGINT/SIGTERM/SIGHUP handlers that KILL every spawned
//       child and rm its tmpdir (P2-6) — even when a test ends with process.exit(),
//   (d) returns the freshly-minted per-instance root cap (read from the sandbox SEED_FILE,
//       never from a log line — so a nav/timeout error can't echo the swissnum).
//
// Usage (CommonJS staging test):
//   const { startIsolatedServer, loadChromium, launchBrowser, injectCap } = require('./test-harness.cjs');
//   const srv = await startIsolatedServer();       // { base, cap, port, dir, close }
//   ... await page.goto(`${srv.base}/`) ...          // never a hardcoded :8778
//   srv.close();                                     // (also auto-run on exit/signal)
//
// Also importable from ESM staging tests (`.staging.test.mjs`) via named imports:
//   import { startIsolatedServer } from './test-harness.cjs';   // CJS named-export interop

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');

const SERVER = path.join(__dirname, 'server.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── global teardown: track every live instance so a signal never orphans a server ───────
const LIVE = new Set();
let hooksInstalled = false;
function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => { for (const h of [...LIVE]) { try { h._kill(); } catch {} } };
  // Normal exit (incl. the exit that follows an uncaughtException) — sync-only work here.
  process.on('exit', killAll);
  // Signals default to terminating WITHOUT running the 'exit' cleanup, orphaning children.
  const onSig = code => () => { killAll(); process.exit(code); };
  process.on('SIGINT', onSig(130));
  process.on('SIGTERM', onSig(143));
  process.on('SIGHUP', onSig(129));
}

/** Grab a genuinely-free TCP port on loopback (probe-then-release). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Spawn an isolated voice-agent server on an ephemeral port with mkdtemp stores.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]       — force a specific port (default: ephemeral/free). Rarely needed.
 * @param {boolean} [opts.lockdown]  — FIELD_LOCKDOWN (default true, matching the confined-fork render path).
 * @param {object} [opts.env]        — extra env vars (override/augment the isolation env).
 * @param {'ignore'|'inherit'|'pipe'|Array} [opts.stdio] — child stdio (default 'ignore'; server logs may carry the cap link).
 * @param {number} [opts.bootTimeoutMs] — max wait for the server to answer (default 20000).
 * @returns {Promise<{base:string,cap:string,port:number,dir:string,child:import('node:child_process').ChildProcess,close:()=>void}>}
 */
async function startIsolatedServer(opts = {}) {
  installHooks();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'va-staging-'));
  const at = sub => path.join(tmp, sub);
  const config = at('config');
  const voice = at('voice');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(voice, { recursive: true });

  const bootTimeoutMs = opts.bootTimeoutMs || 20000;
  const seedFile = path.join(config, 'root.swiss');

  const baseEnv = {
    ...process.env,
    BIND: '127.0.0.1',
    BIND_DEFAULT: '127.0.0.1',
    FIELD_LOCKDOWN: opts.lockdown === false ? '' : '1',
    // Force personal mode: the sandbox config dir starts empty, so field-config's
    // root.swiss-presence probe would otherwise fall to 'platform' and the root cap
    // wouldn't carry the personal/admin powers the live tests exercise.
    FIELD_MODE: 'personal',
    PRINT_ROOT_CAP: '1', // writes the cap to SEED_FILE (we read the FILE, not the log)
    // the four dir seams that (transitively) rebase EVERY store into the sandbox:
    FIELD_CONFIG_DIR: config,
    FIELD_STATE_DIR: at('state'),
    VOICE_STATE_DIR: voice,
    DASH_STATE_DIR: at('dash'),
    OBSIDIAN_VAULT: at('vault'),
    FIELD_HOME_BASE: at('home'),
    // belt-and-suspenders explicit store overrides (also honored directly by server.mjs):
    SEED_FILE: seedFile,
    OUT_DIR: at('out'),
    FORKS_STORE: path.join(voice, 'forks.json'),
    PROJECTS_STORE: at('projects.json'),
    MEMO_RUNS_FILE: at('memo.json'),
    COMPONENT_GIT_DIR: at('component-git'),
    ...(opts.env || {}),
  };

  let child = null;
  let port = 0;
  const attempts = opts.port ? 1 : 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    port = opts.port || (await freePort());
    const base = `http://127.0.0.1:${port}`;
    const env = { ...baseEnv, PORT: String(port), PUBLIC_BASE_URL: base };
    const c = spawn('node', [SERVER], {
      cwd: __dirname,
      env,
      stdio: opts.stdio || ['ignore', 'ignore', 'ignore'],
    });
    let up = false;
    const deadline = Date.now() + bootTimeoutMs;
    while (Date.now() < deadline) {
      if (c.exitCode !== null || c.signalCode !== null) break; // child died — retry a fresh port
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`${base}/`);
        if (r.ok || r.status === 404) { up = true; break; }
      } catch {}
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
    if (up) { child = c; break; }
    try { c.kill('SIGKILL'); } catch {}
    if (opts.port) break; // caller pinned the port; don't reroll
  }

  if (!child) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    throw new Error(`isolated voice-agent server failed to boot within ${bootTimeoutMs}ms`);
  }

  // Mint-on-boot cap: server writes it to SEED_FILE during startup (before it listens),
  // but tolerate a small lag.
  let cap = '';
  for (let i = 0; i < 60 && !cap; i++) {
    try { const s = fs.readFileSync(seedFile, 'utf8').trim(); if (s) cap = s; } catch {}
    // eslint-disable-next-line no-await-in-loop
    if (!cap) await sleep(100);
  }

  const base = `http://127.0.0.1:${port}`;
  let closed = false;
  const handle = {
    base,
    port,
    cap,
    dir: tmp,
    child,
    _kill() {
      try { child.kill('SIGKILL'); } catch {}
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    },
    close() {
      if (closed) return;
      closed = true;
      handle._kill();
      LIVE.delete(handle);
    },
  };
  LIVE.add(handle);
  return handle;
}

// ── headless-browser seams (PORT-5: same env seams as browser-run.cjs, mac-friendly) ────
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE
  || '/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core';
const CHROMIUM_PATH = process.env.FIELD_CHROMIUM
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/chromium');

/** Load playwright-core's chromium (vendored copy first, package fallback). Returns null if unavailable. */
function loadChromium() {
  try { return require(PLAYWRIGHT_CORE).chromium; } catch {}
  try { return require('playwright-core').chromium; } catch {}
  return null;
}

/** Launch opts with the linux-only nettle-soname LD shim (never applied on darwin — it breaks dyld). */
function browserLaunchOpts(extraArgs = []) {
  const env = process.platform === 'linux'
    ? { ...process.env, LD_LIBRARY_PATH: process.env.FIELD_CHROMIUM_LDPATH || '/var/lib/obsidian/oldlibs' }
    : process.env;
  return {
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...extraArgs],
    env,
  };
}

/** chromium.launch() with the portable seams applied. */
function launchBrowser(chromium, extraArgs = []) {
  return chromium.launch(browserLaunchOpts(extraArgs));
}

/**
 * Inject the cap into localStorage BEFORE navigation (cap-hygiene: never put a swissnum in
 * the URL fragment, where a nav/`networkidle` timeout error would echo it into test logs).
 */
async function injectCap(page, cap, extra) {
  await page.addInitScript((args) => {
    try {
      localStorage.setItem('field-agent-cap', args.cap);
      if (args.extra) for (const [k, v] of Object.entries(args.extra)) localStorage.setItem(k, v);
    } catch {}
  }, { cap, extra: extra || null });
}

module.exports = {
  startIsolatedServer,
  freePort,
  loadChromium,
  launchBrowser,
  browserLaunchOpts,
  injectCap,
  CHROMIUM_PATH,
  PLAYWRIGHT_CORE,
};
