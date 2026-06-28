// field-config.test.mjs — the personal/platform SEAM resolves correctly: legacy = personal w/ identical
// paths; FIELD_PERSONAL_ROOT rebases the whole personal family onto the (encrypted) volume; mode override works.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// field-config reads env at module load, so probe each scenario in a child node process.
const probe = env => {
  const code = `import * as c from './field-config.mjs'; process.stdout.write(JSON.stringify({mode:c.FIELD_MODE,personal:c.PERSONAL,CONFIG_DIR:c.CONFIG_DIR,VAULT_DIR:c.VAULT_DIR,STATE_DIR:c.STATE_DIR,PERSONA_FILE:c.PERSONA_FILE,USERS_FILE:c.USERS_FILE,ROOT_SWISS_FILE:c.ROOT_SWISS_FILE,HOME_BASE:c.HOME_BASE,FEED_FILE:c.FEED_FILE}));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: import.meta.dirname, env: { ...process.env, ...env, HOME: '/home/dan' } }).toString());
};
// strip any inherited overrides so we test the genuine defaults
const CLEAN = { FIELD_PERSONAL_ROOT: '', FIELD_MODE: '', FIELD_CONFIG_DIR: '', OBSIDIAN_VAULT: '', FIELD_STATE_DIR: '', USERS_FILE: '', SEED_FILE: '', PERSONA_FILE: '', FEED_FILE: '', FIELD_HOME_BASE: '' };

test('legacy home layout → identical default paths', () => {
  const c = probe({ ...CLEAN });
  assert.equal(c.CONFIG_DIR, '/home/dan/.config/field-agent');
  assert.equal(c.VAULT_DIR, '/home/dan/obsidian/vault');
  assert.equal(c.PERSONA_FILE, '/home/dan/.config/field-agent/persona.txt');
  assert.equal(c.USERS_FILE, '/home/dan/.config/field-agent/users.json');
  assert.equal(c.ROOT_SWISS_FILE, '/home/dan/.config/field-agent/root.swiss');
  assert.equal(c.HOME_BASE, '/home/dan/.local/state/field-agent/home');
  assert.equal(c.FEED_FILE, '/home/dan/.local/state/field-dashboard/feed.json');
});

test('mode keys on root.swiss PRESENCE — present → personal, absent → platform (the bind/scrub signal)', () => {
  const withSwiss = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(withSwiss, 'root.swiss'), 'deadbeef');
  const p = probe({ ...CLEAN, FIELD_CONFIG_DIR: withSwiss });
  assert.equal(p.mode, 'personal'); assert.equal(p.personal, true);

  const noSwiss = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')); // dir EXISTS but no root.swiss (an empty mountpoint after scrub+lock)
  const q = probe({ ...CLEAN, FIELD_CONFIG_DIR: noSwiss });
  assert.equal(q.mode, 'platform'); assert.equal(q.personal, false);
  fs.rmSync(withSwiss, { recursive: true, force: true }); fs.rmSync(noSwiss, { recursive: true, force: true });
});

test('FIELD_PERSONAL_ROOT with marker → personal, whole family rebased onto the volume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  fs.writeFileSync(path.join(root, 'personal.json'), JSON.stringify({ user: 'dan' }));
  const c = probe({ ...CLEAN, FIELD_PERSONAL_ROOT: root });
  assert.equal(c.mode, 'personal'); assert.equal(c.personal, true);
  assert.equal(c.CONFIG_DIR, path.join(root, 'config'));
  assert.equal(c.VAULT_DIR, path.join(root, 'vault'));
  assert.equal(c.STATE_DIR, path.join(root, 'state/field-agent'));
  assert.equal(c.PERSONA_FILE, path.join(root, 'config/persona.txt'));
  assert.equal(c.USERS_FILE, path.join(root, 'config/users.json'));
  assert.equal(c.ROOT_SWISS_FILE, path.join(root, 'config/root.swiss'));
  assert.equal(c.HOME_BASE, path.join(root, 'state/field-agent/home'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('FIELD_PERSONAL_ROOT WITHOUT marker → platform mode (no personal data present)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvol-'));
  const c = probe({ ...CLEAN, FIELD_PERSONAL_ROOT: root });
  assert.equal(c.mode, 'platform'); assert.equal(c.personal, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('FIELD_MODE=platform forces platform even on legacy layout', () => {
  const c = probe({ ...CLEAN, FIELD_MODE: 'platform' });
  assert.equal(c.mode, 'platform'); assert.equal(c.personal, false);
});
