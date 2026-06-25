// forks.test.mjs — unit coverage for the fork→edit→re-share store (forks.mjs). Pure logic, no browser.
import '@endo/init'; // lockdown + harden, FIRST (so forks.mjs's module-level harden() resolves)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeForks } from './forks.mjs';
import { makePurse } from './purse.mjs';
import { makePurseStore } from './purse-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forks-test-'));
const setup = () => {
  const dir = tmp();
  const purseStore = makePurseStore({ file: path.join(dir, 'purses.json'), debounceMs: 0 });
  const forks = makeForks({ file: path.join(dir, 'forks.json'), makePurse, purseStore });
  return { dir, forks };
};
const SRC = "(endowments, props) => endowments.h('div', null, 'hi ' + (props.name||''))";
const SRC2 = "(endowments, props) => endowments.h('strong', null, 'EDITED')";

test('create → read → list is owner-gated', () => {
  const { forks } = setup();
  const r = forks.create({ source: SRC, name: 'My fork', baseId: 'island-file-browser', owner: 'alice' });
  assert.ok(r.ok && r.id, 'created');
  assert.equal(forks.source(r.id, 'alice'), SRC, 'owner reads source');
  assert.equal(forks.source(r.id, 'mallory'), null, 'non-owner cannot read source');
  assert.equal(forks.read(r.id, 'mallory'), null, 'non-owner cannot read');
  assert.equal(forks.list('alice').length, 1, 'alice sees her fork');
  assert.equal(forks.list('mallory').length, 0, 'mallory sees nothing');
  assert.equal(forks.read(r.id, 'alice').version, 1, 'starts at v1');
});

test('edit appends versions; revert is non-destructive', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'f', owner: 'alice' });
  const e = forks.edit(id, SRC2, 'alice', 'make bold');
  assert.ok(e.ok && e.version === 2, 'edit → v2');
  assert.equal(forks.source(id, 'alice'), SRC2, 'source updated');
  assert.equal(forks.history(id, 'alice').length, 2, 'two versions');
  const rv = forks.revert(id, 1, 'alice');
  assert.ok(rv.ok && rv.version === 3, 'revert → NEW v3 (non-destructive)');
  assert.equal(forks.source(id, 'alice'), SRC, 'reverted to v1 source');
  assert.equal(forks.history(id, 'alice').length, 3, 'history preserved (3 versions)');
});

test('non-owner cannot edit/share/revoke/remove', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'f', owner: 'alice' });
  assert.equal(forks.edit(id, SRC2, 'mallory').ok, false, 'mallory cannot edit');
  assert.equal(forks.share({ id, owner: 'mallory' }).ok, false, 'mallory cannot share');
  assert.equal(forks.remove(id, 'mallory'), false, 'mallory cannot remove');
  assert.equal(forks.source(id, 'alice'), SRC, 'fork untouched by mallory');
});

test('source size + empty are rejected', () => {
  const { forks } = setup();
  assert.equal(forks.create({ source: '', owner: 'alice' }).ok, false, 'empty rejected');
  assert.equal(forks.create({ source: 'x'.repeat(64 * 1024 + 1), owner: 'alice' }).ok, false, 'oversize rejected');
  assert.equal(forks.create({ source: SRC, owner: '' }).ok, false, 'ownerless rejected');
});

test('free share vends ONLY the source; revoke kills it', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'sharable', owner: 'alice' });
  const s = forks.share({ id, owner: 'alice', charge: { scheme: 'free' } });
  assert.ok(s.ok && s.token, 'minted a token');
  const open = forks.openShare(s.token);
  assert.ok(open.ok && open.source === SRC && open.name === 'sharable', 'recipient gets the source to render');
  assert.ok(!('owner' in open) && !('history' in open) && !('purseKey' in open), 'share leaks no owner/history/secret — only source + render-safe version metadata');
  assert.ok(forks.revokeShare(s.token, 'alice'), 'owner revokes');
  assert.equal(forks.openShare(s.token).ok, false, 'revoked token is dead');
});

test('allowance share is metered per open and runs dry', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'metered', owner: 'alice' });
  const s = forks.share({ id, owner: 'alice', charge: { scheme: 'allowance', total: 25000, perOpen: 10000 } });
  assert.ok(forks.openShare(s.token).ok, 'open 1 ok (15000 left)');
  assert.ok(forks.openShare(s.token).ok, 'open 2 ok (5000 left)');
  const third = forks.openShare(s.token);
  assert.equal(third.ok, false, 'open 3 denied — allowance used up');
  assert.match(third.error, /allowance/i, 'clear error');
});

test('expires share dies after its window (revoked path)', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'leased', owner: 'alice' });
  const s = forks.share({ id, owner: 'alice', charge: { scheme: 'expires', hours: 1 } });
  assert.ok(forks.openShare(s.token).ok, 'works within the window');
  assert.ok(forks.revokeShare(s.token, 'alice'), 'and is independently revocable');
  assert.equal(forks.openShare(s.token).ok, false, 'dead after revoke');
});

test('Phase 4: share pins to invite-version; owner edits are an upgrade the recipient chooses', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'upgradable', owner: 'alice' }); // v1
  const s = forks.share({ id, owner: 'alice', charge: { scheme: 'free' } });
  let o = forks.openShare(s.token);
  assert.ok(o.ok && o.source === SRC && o.version === 1 && o.upgradeAvailable === false, 'recipient opens at v1, no upgrade');

  forks.edit(id, SRC2, 'alice'); // owner → v2
  o = forks.openShare(s.token);
  assert.ok(o.source === SRC && o.version === 1, 'recipient STAYS on v1 (non-destructive — not force-upgraded)');
  assert.equal(o.upgradeAvailable, true, 'but an upgrade IS flagged (currentVersion 2 > pinned 1)');

  const pv = forks.previewUpgrade(s.token);
  assert.ok(pv.ok && pv.source === SRC2 && pv.version === 2, 'previewUpgrade = try-on the latest WITHOUT committing');
  assert.equal(forks.openShare(s.token).version, 1, 'preview did not change the pin (still v1)');

  const acc = forks.acceptUpgrade(s.token);
  assert.ok(acc.ok && acc.version === 2 && acc.source === SRC2, 'acceptUpgrade atomically jumps to v2');
  assert.equal(forks.openShare(s.token).upgradeAvailable, false, 'no upgrade pending after accept');
});

test('Phase 4: auto-accept rides the latest; inbox carries owner notices', () => {
  const { forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'auto', owner: 'alice' });
  const s = forks.share({ id, owner: 'alice', charge: { scheme: 'free' } });
  forks.setAutoAccept(s.token, true);
  forks.edit(id, SRC2, 'alice'); // v2
  const o = forks.openShare(s.token);
  assert.ok(o.source === SRC2 && o.version === 2 && o.autoAccept === true && o.upgradeAvailable === false, 'auto-accept always serves the latest');

  const n = forks.notifyRecipients(id, 'alice', 'made it bold — fyi');
  assert.ok(n.ok && n.delivered === 1, 'owner notified 1 recipient');
  assert.equal(forks.notifyRecipients(id, 'mallory', 'x').ok, false, 'a non-owner cannot notify');
  const inbox = forks.shareInbox(s.token);
  assert.ok(inbox.ok && inbox.inbox.length === 1 && /made it bold/.test(inbox.inbox[0].message), 'recipient reads the owner inbox');
});

test('persists across reopen (durable store)', () => {
  const { dir, forks } = setup();
  const { id } = forks.create({ source: SRC, name: 'durable', owner: 'alice' });
  forks.edit(id, SRC2, 'alice');
  const reopened = makeForks({ file: path.join(dir, 'forks.json'), makePurse, purseStore: makePurseStore({ file: path.join(dir, 'purses.json'), debounceMs: 0 }) });
  assert.equal(reopened.source(id, 'alice'), SRC2, 'fork survived reload');
  assert.equal(reopened.read(id, 'alice').version, 2, 'version survived');
});
