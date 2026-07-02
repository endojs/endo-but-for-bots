// feed-isolation.test.mjs — INC-2 (per-user isolation): the notification feed / 🔔 bell store is partitioned
// per user. Proves (a) root/user-0 keeps the shared FEED_FILE (a tenant post NEVER touches it), (b) a tenant
// reads + writes ONLY its own feed and never sees dan's stream, (c) tenant A's feed is invisible to tenant B.
//
//   node --test packages/chat/voice-agent/feed-isolation.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-iso-'));
const FEED_FILE = path.join(TMP, 'feed.json'); // stand-in for dan's shared dashboard feed
process.env.DASH_STATE_DIR = TMP;
process.env.FEED_FILE = FEED_FILE;
process.env.FEED_MJS = path.join(TMP, 'no-such-feed-cli.mjs'); // root CLI path is inert here (we never post as root)
process.env.FIELD_CONFIG_DIR = path.join(TMP, 'config');
process.env.FIELD_HOME_BASE = path.join(TMP, 'home');
process.env.SCOPED_CAPS_FILE = path.join(TMP, 'scoped.json');

const { makeFieldAgent, ownerKeyForCap } = await import('./agent-caps.mjs');

const feedFileFor = owner => (owner === 'root') ? FEED_FILE : path.join(TMP, `feed-${owner.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.json`);
const readEntries = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).entries || []; } catch { return []; } };
// `feed` is a PERSONAL power (granted to invitees only in PERSONAL mode — this is the personal-mode-with-
// invitees scenario the feed partition protects), so build the agent in personal mode.
const mk = () => makeFieldAgent({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'feed-out-')), baseUrl: 'http://test.invalid', autoConfirmFile: path.join(TMP, `ac-${Math.random().toString(16).slice(2)}.json`), specialistsFile: path.join(TMP, 'spec.json'), fieldMode: 'personal' });
const tb = (fa, swiss) => fa.nodeFor(swiss).toolbox({ chatId: 'c' }).toolbox;

test('a tenant writes + reads ONLY its own feed; dan\'s shared FEED_FILE is never touched or seen', async () => {
  // Seed dan's shared feed with a private item.
  fs.writeFileSync(FEED_FILE, JSON.stringify({ entries: [
    { id: 'dan1', date: new Date().toISOString(), title: 'DAN SECRET', body: 'approve host shell', status: '🔔 needs your attention' },
  ] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['feed'], label: 'TenantA' });
  const ownerA = ownerKeyForCap(a.swiss);

  const before = readEntries(FEED_FILE).length;
  await tb(fa, a.swiss).notify.run({ title: 'A item', body: 'a body' });

  // dan's shared feed is UNCHANGED by the tenant's post
  assert.equal(readEntries(FEED_FILE).length, before, 'tenant post does NOT write dan\'s shared FEED_FILE');
  assert.ok(readEntries(FEED_FILE).some(e => e.title === 'DAN SECRET'), 'dan\'s item is intact');

  // the tenant's item landed in ITS OWN feed file
  const aEntries = readEntries(feedFileFor(ownerA));
  assert.ok(aEntries.some(e => e.title === 'A item'), 'tenant A\'s notify landed in feed-<ownerA>.json');

  // the tenant reads ITS OWN inbox — its item, NOT dan's secret
  const aInbox = (await tb(fa, a.swiss).listNotifications.run()).items;
  assert.ok(aInbox.some(i => i.title === 'A item'), 'tenant A sees its own item');
  assert.ok(!aInbox.some(i => i.title === 'DAN SECRET'), 'tenant A does NOT see dan\'s feed');
});

test('tenant A\'s feed is invisible to tenant B (and vice-versa)', async () => {
  fs.writeFileSync(FEED_FILE, JSON.stringify({ entries: [] }));
  const fa = mk();
  const a = fa.mintScopedCap({ powers: ['feed'], label: 'TA2' });
  const b = fa.mintScopedCap({ powers: ['feed'], label: 'TB2' });
  await tb(fa, a.swiss).notify.run({ title: 'A-only', body: '' });
  await tb(fa, b.swiss).notify.run({ title: 'B-only', body: '' });

  const aInbox = (await tb(fa, a.swiss).listNotifications.run()).items.map(i => i.title);
  const bInbox = (await tb(fa, b.swiss).listNotifications.run()).items.map(i => i.title);
  assert.ok(aInbox.includes('A-only') && !aInbox.includes('B-only'), 'tenant A sees only its own');
  assert.ok(bInbox.includes('B-only') && !bInbox.includes('A-only'), 'tenant B sees only its own');
});

test('root/user-0 uses the shared FEED_FILE (its owner key = root; store path = FEED_FILE)', () => {
  const fa = mk();
  assert.equal(fa.rootNode.ownerKey, 'root', 'root node owner key is the literal "root" (legacy = user-0)');
  assert.equal(feedFileFor('root'), FEED_FILE, 'root\'s per-owner feed file IS the shared FEED_FILE (byte-identical)');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
