// user-store.test.mjs — per-user capabilities: minting a persistent user-cap (prefs + Root pointer), resolving
// it, merging prefs, and pointing a user at their own app variant (Root pointer). cap-hygiene: the user-cap is
// stored ONLY as a hash (never plaintext on disk).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeUserStore } from './user-store.mjs';

test('user-cap: mint → resolve → prefs merge → per-user Root pointer; hashed on disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'userstore-')), 'users.json');
  const store = makeUserStore({ file });
  try {
    // mint a persistent user-cap (the server has already verified the opener holds a valid invite cap)
    const u = store.mint({ prefs: { theme: 'dark' } });
    assert.ok(u.ok && /^[0-9a-f]{32}$/.test(u.userCap), 'mints a 32-hex user-cap');
    assert.equal(u.root, 'canonical', 'defaults to the shared canonical root');
    assert.deepEqual(u.prefs, { theme: 'dark' }, 'carries the initial prefs');

    // resolve the held user-cap
    const got = store.get(u.userCap);
    assert.deepEqual(got, { root: 'canonical', prefs: { theme: 'dark' } }, 'resolves the cap → its view');
    assert.equal(store.get('deadbeef'), null, 'an unknown user-cap resolves to null');

    // prefs merge (shallow)
    store.setPrefs(u.userCap, { fontSize: 16 });
    assert.deepEqual(store.get(u.userCap).prefs, { theme: 'dark', fontSize: 16 }, 'prefs shallow-merge');

    // per-user variant: point this user at their OWN root (a forked shell version) — diverges from canonical
    store.setRoot(u.userCap, 'root-fork-abc');
    assert.equal(store.get(u.userCap).root, 'root-fork-abc', 'the user now sees their own variant');

    // a SECOND user is independent (their own cap, own root/prefs)
    const u2 = store.mint();
    assert.notEqual(u2.userCap, u.userCap, 'each user gets a distinct cap');
    assert.equal(store.get(u2.userCap).root, 'canonical', "the second user is on canonical, unaffected by the first's variant");

    // cap-hygiene: NO plaintext user-cap on disk (only sha256 hashes)
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(u.userCap) && !raw.includes(u2.userCap), 'user-cap swissnums are never written in plaintext (hashed keys)');
    assert.equal(store.count(), 2);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
