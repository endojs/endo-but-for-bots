// field-config-secrets-paths.test.mjs — ARCH-3 proof: the secrets/config paths in the cold-owned
// files (pay/asks-store/connectors/internal-messages/…) now compose from field-config's CONFIG_DIR /
// STATE_DIR / DASH_STATE_DIR seam, so they (a) keep the byte-identical default on this box and
// (b) rebase onto FIELD_PERSONAL_ROOT (the encrypted-drive route) automatically — nothing personal
// stays on the box when the volume is pulled. Modules read env + call harden() at load, so each
// scenario runs in a child node process that installs SES first, then imports the target module.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// strip inherited overrides so we exercise the genuine defaults (not a stray env var)
const CLEAN = {
  FIELD_PERSONAL_ROOT: '', FIELD_MODE: '', FIELD_CONFIG_DIR: '', FIELD_STATE_DIR: '',
  DASH_STATE_DIR: '', VOICE_STATE_DIR: '', OBSIDIAN_VAULT: '',
  STRIPE_CONFIG: '', PAY_STORE: '', CONNECTORS_STORE: '', INTERNAL_MESSAGES_FILE: '',
};

// run an ESM snippet in a child that installs SES (@endo/init) before importing the target module.
const run = (env, body) => {
  const code = `import '@endo/init';\n${body}`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: import.meta.dirname,
    env: { ...process.env, ...CLEAN, ...env },
  }).toString();
};

test('asks-store: default paths byte-identical (SECRETS_DIR under CONFIG_DIR, ASKS_FILE under DASH_STATE_DIR)', () => {
  const out = run({ HOME: '/home/dan' },
    `const m = await import('./asks-store.mjs'); process.stdout.write(JSON.stringify({ secrets: m.SECRETS_DIR, asks: m.ASKS_FILE }));`);
  const c = JSON.parse(out);
  assert.equal(c.secrets, '/home/dan/.config/field-agent/secrets');
  assert.equal(c.asks, '/home/dan/.local/state/field-dashboard/asks.json');
});

test('asks-store: FIELD_PERSONAL_ROOT rebases SECRETS_DIR + ASKS_FILE onto the volume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  const out = run({ HOME: '/home/dan', FIELD_PERSONAL_ROOT: root },
    `const m = await import('./asks-store.mjs'); process.stdout.write(JSON.stringify({ secrets: m.SECRETS_DIR, asks: m.ASKS_FILE }));`);
  const c = JSON.parse(out);
  assert.equal(c.secrets, path.join(root, 'config/secrets'));
  assert.equal(c.asks, path.join(root, 'state/field-dashboard/asks.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pay: Stripe config still found at the DEFAULT ~/.config/field-agent/stripe.json path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  fs.mkdirSync(path.join(home, '.config/field-agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/field-agent/stripe.json'), JSON.stringify({ secretKey: 'sk_test_x', webhookSecret: 'wh_x' }));
  const out = run({ HOME: home },
    `const m = await import('./pay.mjs'); process.stdout.write(JSON.stringify({ configured: m.stripeConfigured(), key: (m.loadStripeCfg()||{}).secretKey }));`);
  const c = JSON.parse(out);
  assert.equal(c.configured, true);
  assert.equal(c.key, 'sk_test_x');
  fs.rmSync(home, { recursive: true, force: true });
});

test('pay: Stripe config rebases onto FIELD_PERSONAL_ROOT/config/stripe.json (NOT the home path)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/stripe.json'), JSON.stringify({ secretKey: 'sk_vol_y' }));
  // HOME points at an EMPTY temp home with no stripe.json → the only way this resolves is via the volume.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const out = run({ HOME: home, FIELD_PERSONAL_ROOT: root },
    `const m = await import('./pay.mjs'); process.stdout.write(JSON.stringify({ configured: m.stripeConfigured(), key: (m.loadStripeCfg()||{}).secretKey }));`);
  const c = JSON.parse(out);
  assert.equal(c.configured, true);
  assert.equal(c.key, 'sk_vol_y');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('connectors: registry store reads from the rebased FIELD_PERSONAL_ROOT/config/connectors.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config/connectors.json'), JSON.stringify({ connectors: [{ id: 'conn-abc', name: 'demo', baseUrl: 'https://x' }] }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const out = run({ HOME: home, FIELD_PERSONAL_ROOT: root },
    `const m = await import('./connectors.mjs'); const c = m.makeConnectors({ getSecret: () => '' }); process.stdout.write(JSON.stringify(c.list().map(x => x.name)));`);
  assert.deepEqual(JSON.parse(out), ['demo']);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('internal-messages: writes to the rebased FIELD_PERSONAL_ROOT/state/field-agent/internal-messages.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  run({ HOME: home, FIELD_PERSONAL_ROOT: root },
    `const m = await import('./internal-messages.mjs'); m.postInternal({ title: 'seam-check' }); process.stdout.write('ok');`);
  const rebased = path.join(root, 'state/field-agent/internal-messages.json');
  assert.ok(fs.existsSync(rebased), 'internal-messages.json landed on the volume');
  assert.equal(fs.existsSync(path.join(home, '.local/state/field-agent/internal-messages.json')), false, 'nothing written to the home path');
  const msgs = JSON.parse(fs.readFileSync(rebased, 'utf8')).messages;
  assert.equal(msgs[0].title, 'seam-check');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
