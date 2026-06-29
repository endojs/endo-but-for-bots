// bluesky-raindrop.test.mjs — the "Invite Bluesky users by Raindrop" pipeline, end to end against a FAKE fetch:
// Raindrop paging + bsky-profile extraction/dedup → stable per-identity namespace mint (via the real
// invite-policy seam) → delivery (dm carries the cap-link privately; mention carries NO link) → idempotency →
// cap-hygiene (no swissnum ever leaves in a return value).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeInvitePolicies } from './invite-policy.mjs';
import { makeBlueskyRaindropInviter, parseBskyProfile } from './bluesky-raindrop.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-'));

// 50 + 12 raindrops across two pages; some bsky profiles (one dup, one DID, one non-bsky link).
const makeRaindropPages = () => {
  const items = [];
  for (let i = 0; i < 50; i += 1) items.push({ _id: i, link: `https://example.com/x${i}`, title: `junk ${i}` });
  // page 0 also carries a couple of bsky profiles
  items[3] = { _id: 3, link: 'https://bsky.app/profile/alice.bsky.social', title: 'Alice' };
  items[7] = { _id: 7, link: 'https://bsky.app/profile/did:plc:bob123', title: 'Bob' };
  const page1 = [
    { _id: 100, link: 'https://bsky.app/profile/carol.bsky.social', title: 'Carol' },
    { _id: 101, link: 'https://bsky.app/profile/alice.bsky.social', title: 'Alice dup' }, // dedup
    { _id: 102, link: 'https://news.ycombinator.com/x', title: 'not bsky' },
  ];
  return { page0: items, page1, count: items.length + page1.length };
};

// A fake fetch that records calls and answers Raindrop + Bluesky endpoints from canned data.
const makeFakeFetch = (rd, calls) => async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
  const ok = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url.includes('/rest/v1/raindrops/')) {
    const page = Number(new URL(url).searchParams.get('page'));
    return ok({ items: page === 0 ? rd.page0 : page === 1 ? rd.page1 : [], count: rd.count });
  }
  if (url.includes('/rest/v1/collections')) return ok({ items: [{ _id: 555, title: 'Bluesky invites', count: rd.count }] });
  if (url.includes('com.atproto.server.createSession')) return ok({ accessJwt: 'JWT', refreshJwt: 'R', did: 'did:plc:me', handle: 'me.bsky.social' });
  if (url.includes('com.atproto.identity.resolveHandle')) {
    const h = new URL(url).searchParams.get('handle');
    return ok({ did: `did:plc:${h.split('.')[0]}` });
  }
  if (url.includes('chat.bsky.convo.getConvoForMembers')) return ok({ convo: { id: `convo-${body.members[0]}` } });
  if (url.includes('chat.bsky.convo.sendMessage')) return ok({ id: 'msg1', text: body.message.text });
  if (url.includes('com.atproto.repo.createRecord')) return ok({ uri: 'at://post', cid: 'cid1' });
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'nope' };
};

const setup = ({ deliver = 'dm' } = {}) => {
  const dir = tmp();
  const configFile = path.join(dir, 'bluesky-raindrop.json');
  fs.writeFileSync(configFile, JSON.stringify({
    raindrop: { token: 'RD' },
    bluesky: { identifier: 'me.bsky.social', appPassword: 'app-pass-word' },
    deliver,
    collection: 'Bluesky invites',
  }));
  const minted = [];
  const invitePolicies = makeInvitePolicies({
    file: path.join(dir, 'policies.json'),
    mintNamespaceCap: ({ powers, label }) => { const swiss = `swiss${minted.length}${(label || '').replace(/\W/g, '')}`; minted.push({ swiss, powers, label }); return { swiss, powers }; },
  });
  const calls = [];
  const inviter = makeBlueskyRaindropInviter({
    configFile,
    stateFile: path.join(dir, 'invited.json'),
    invitePolicies,
    ring: ['reference', 'research', 'images', 'contact', 'home'],
    baseUrl: 'https://agentc.example',
    fetchImpl: makeFakeFetch(makeRaindropPages(), calls),
    throttleMs: 0,
  });
  return { inviter, calls, minted, dir };
};

const noSwiss = obj => !/swiss|#cap=/.test(JSON.stringify(obj));

test('parseBskyProfile extracts handles + DIDs, rejects non-profiles', () => {
  assert.equal(parseBskyProfile('https://bsky.app/profile/alice.bsky.social').id, 'alice.bsky.social');
  assert.equal(parseBskyProfile('https://bsky.app/profile/did:plc:x').isDid, true);
  assert.equal(parseBskyProfile('https://example.com/x'), null);
});

test('status reports missing creds and the runbook fields', () => {
  const dir = tmp();
  const configFile = path.join(dir, 'c.json'); fs.writeFileSync(configFile, '{}');
  const inviter = makeBlueskyRaindropInviter({ configFile, stateFile: path.join(dir, 's.json'), invitePolicies: makeInvitePolicies({ file: path.join(dir, 'p.json'), mintNamespaceCap: () => ({ swiss: 'x' }) }), baseUrl: 'https://x' });
  const s = inviter.status();
  assert.equal(s.ok, false);
  assert.ok(s.missing.includes('raindrop.token'));
  assert.ok(s.missing.some(m => m.includes('bluesky')));
});

test('preview is a DRY RUN: finds + dedups bsky profiles, mints nothing, leaks no cap', async () => {
  const { inviter, calls, minted } = setup();
  const p = await inviter.preview({ collection: 'Bluesky invites' });
  assert.equal(p.found, 3, 'alice, bob, carol (alice deduped, non-bsky ignored)');
  assert.equal(minted.length, 0, 'preview mints nothing');
  assert.ok(!calls.some(c => c.url.includes('createSession')), 'preview does not touch Bluesky');
  assert.ok(noSwiss(p), 'no swissnum/#cap in preview output');
});

test('invite(dm): mints a stable namespace per identity + DMs each their cap-link privately', async () => {
  const { inviter, calls, minted } = setup({ deliver: 'dm' });
  const r = await inviter.invite({ collection: 'Bluesky invites' });
  assert.equal(r.minted, 3); assert.equal(r.delivered, 3); assert.equal(r.mode, 'dm');
  assert.equal(minted.length, 3, 'three namespace caps minted');

  // exactly one login (session reused), three convos, three messages
  assert.equal(calls.filter(c => c.url.includes('createSession')).length, 1, 'session reused, not per-recipient');
  const sends = calls.filter(c => c.url.includes('sendMessage'));
  assert.equal(sends.length, 3);
  // the DM carries the actual cap-link, and the chat-proxy header is set
  assert.ok(sends.every(s => /https:\/\/agentc\.example\/#cap=swiss/.test(s.body.message.text)), 'DM contains the invite cap-link');
  assert.ok(sends.every(s => s.headers['atproto-proxy'] === 'did:web:api.bsky.chat#bsky_chat'), 'chat proxy header present');

  // CAP HYGIENE: the swissnum is in the DM (private, to its designated recipient) but NEVER in the return value
  assert.ok(noSwiss(r), 'invite() return leaks no swissnum/#cap');
});

test('invite is idempotent: re-running skips already-delivered + reuses the same caps', async () => {
  const { inviter, minted } = setup({ deliver: 'dm' });
  await inviter.invite({ collection: 'Bluesky invites' });
  const before = minted.length;
  const again = await inviter.invite({ collection: 'Bluesky invites' });
  assert.equal(again.minted, 0, 'no new mints on re-run');
  assert.equal(again.delivered, 0, 'no re-delivery');
  assert.equal(minted.length, before, 'cap set unchanged (stable per identity)');
  assert.ok(again.skipped.length >= 3);
});

test('invite(mention): public post carries NO link (cap never goes public)', async () => {
  const { inviter, calls } = setup({ deliver: 'mention' });
  const r = await inviter.invite({ collection: 'Bluesky invites', deliver: 'mention' });
  assert.equal(r.mode, 'mention'); assert.equal(r.delivered, 3);
  const posts = calls.filter(c => c.url.includes('createRecord'));
  assert.equal(posts.length, 3);
  assert.ok(posts.every(p => !/#cap=/.test(p.body.record.text)), 'no cap-link in any public post');
  assert.ok(posts.every(p => p.body.record.facets?.[0]?.features?.[0]?.$type === 'app.bsky.richtext.facet#mention'), 'mention facet present');
  assert.ok(noSwiss(r));
});

test('invite(none): mints namespaces but sends nothing', async () => {
  const { inviter, calls, minted } = setup({ deliver: 'none' });
  const r = await inviter.invite({ collection: 'Bluesky invites', deliver: 'none' });
  assert.equal(r.minted, 3); assert.equal(r.delivered, 0);
  assert.equal(minted.length, 3);
  assert.ok(!calls.some(c => c.url.includes('bsky')), 'no Bluesky calls in none mode');
});
