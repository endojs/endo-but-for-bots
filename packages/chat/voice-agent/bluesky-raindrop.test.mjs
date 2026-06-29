// bluesky-raindrop.test.mjs — the eligibility allow-list + the claim orchestration, against fakes (no network,
// no OAuth lib): Raindrop paging → handle→DID resolution → DID/handle eligibility match; then claim = eligible →
// stable namespace + one-time credit grant; ineligible → no namespace, no credits; idempotent re-claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeInvitePolicies } from './invite-policy.mjs';
import { makeBlueskyEligibility, parseBskyProfile } from './bluesky-raindrop.mjs';
import { makeBlueskyClaim } from './bluesky-claim.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bsky-'));

// A Raindrop collection: 50 junk + a couple of bsky profiles on page 0, more on page 1 (one dup, one DID, one non-bsky).
const pages = () => {
  const p0 = [];
  for (let i = 0; i < 50; i += 1) p0.push({ _id: i, link: `https://example.com/x${i}` });
  p0[3] = { _id: 3, link: 'https://bsky.app/profile/alice.bsky.social' };
  p0[7] = { _id: 7, link: 'https://bsky.app/profile/did:plc:bob' };
  const p1 = [
    { _id: 100, link: 'https://bsky.app/profile/carol.bsky.social' },
    { _id: 101, link: 'https://bsky.app/profile/alice.bsky.social' }, // dup
    { _id: 102, link: 'https://news.ycombinator.com/x' }, // not bsky
  ];
  return { p0, p1, count: p0.length + p1.length };
};

// fake fetch: Raindrop collections/raindrops + public resolveHandle (handle → did:plc:<first-label>)
const fakeFetch = (rd, calls = []) => async (input) => {
  const url = String(input);
  calls.push(url);
  const ok = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url.includes('/rest/v1/raindrops/')) { const page = Number(new URL(url).searchParams.get('page')); return ok({ items: page === 0 ? rd.p0 : page === 1 ? rd.p1 : [], count: rd.count }); }
  if (url.includes('/rest/v1/collections')) return ok({ items: [{ _id: 555, title: 'Bluesky invites', count: rd.count }] });
  if (url.includes('com.atproto.identity.resolveHandle')) { const h = new URL(url).searchParams.get('handle'); return ok({ did: `did:plc:${h.split('.')[0]}` }); }
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'nope' };
};

const mkEligibility = ({ calls = [] } = {}) => {
  const dir = tmp();
  const configFile = path.join(dir, 'bluesky-raindrop.json');
  fs.writeFileSync(configFile, JSON.stringify({ raindrop: { token: 'RD' }, collection: 'Bluesky invites' }));
  let t = 0;
  return makeBlueskyEligibility({ configFile, fetchImpl: fakeFetch(pages(), calls), now: () => (t += 1) });
};

test('parseBskyProfile extracts handles + DIDs, rejects non-profiles', () => {
  assert.equal(parseBskyProfile('https://bsky.app/profile/alice.bsky.social').id, 'alice.bsky.social');
  assert.equal(parseBskyProfile('https://bsky.app/profile/did:plc:x').isDid, true);
  assert.equal(parseBskyProfile('https://example.com/x'), null);
});

test('eligibility: collection → DID + handle allow-list (paging + dedup + handle→DID)', async () => {
  const calls = [];
  const e = mkEligibility({ calls });
  const snap = await e.snapshot({ collection: 'Bluesky invites' });
  // alice + carol resolved to dids; bob already a did
  assert.ok(snap.dids.has('did:plc:bob'));
  assert.ok(snap.dids.has('did:plc:alice'));
  assert.ok(snap.dids.has('did:plc:carol'));
  assert.equal(snap.handles.size, 2, 'alice + carol handles (bob was a DID); alice deduped');
  assert.ok([...new Set(calls)].some(c => c.includes('resolveHandle')), 'resolved handles via public API');
});

test('eligibility: matches on DID and on case-folded handle; rejects strangers', async () => {
  const e = mkEligibility();
  assert.equal(await e.isEligible({ did: 'did:plc:bob' }), true, 'DID match');
  assert.equal(await e.isEligible({ did: 'did:plc:nobody', handle: 'Alice.BSKY.social' }), true, 'handle match, case-insensitive');
  assert.equal(await e.isEligible({ did: 'did:plc:stranger', handle: 'mallory.bsky.social' }), false);
});

// ── sign-in / claim orchestration (zero-until-claim) ─────────────────────────────────────────────────────────
const mkClaim = () => {
  const dir = tmp();
  const minted = [];
  const invitePolicies = makeInvitePolicies({ file: path.join(dir, 'policies.json'), mintNamespaceCap: ({ powers, label }) => { const swiss = `swiss-${minted.length}`; minted.push({ swiss, powers, label }); return { swiss, powers }; } });
  const credited = [];
  const claimStore = (() => { let d = { byDid: {}, namespaces: {} }; return { read: () => d, write: x => { d = x; } }; })();
  const claim = makeBlueskyClaim({
    eligibility: mkEligibility(),
    invitePolicies,
    ring: ['reference', 'home'],
    grantUusd: 1_000_000,
    grantCredits: (cap, uusd) => credited.push({ cap, uusd }),
    store: claimStore,
  });
  return { claim, minted, credited };
};

test('signIn: eligible DID → stable namespace + one-time fund', async () => {
  const { claim, minted, credited } = mkClaim();
  const r = await claim.signIn({ did: 'did:plc:bob' });
  assert.equal(r.ok, true); assert.equal(r.eligible, true); assert.equal(r.claimed, true);
  assert.ok(r.scopedCap, 'minted a namespace cap');
  assert.equal(r.granted, 1_000_000, 'funded the claim allowance');
  assert.equal(minted.length, 1);
  assert.equal(credited.length, 1); assert.equal(credited[0].uusd, 1_000_000);
  assert.equal(claim.isNamespace(r.scopedCap), true, 'cap is marked a Bluesky namespace (→ shared zero wallet)');
});

test('signIn: INELIGIBLE → still gets a namespace (signed in), but ZERO credits', async () => {
  const { claim, minted, credited } = mkClaim();
  const r = await claim.signIn({ did: 'did:plc:stranger' });
  assert.equal(r.ok, true); assert.equal(r.eligible, false); assert.equal(r.claimed, false);
  assert.ok(r.scopedCap, 'signed in: got a namespace');
  assert.equal(r.granted, 0, 'no credits until they claim');
  assert.equal(minted.length, 1, 'namespace minted for the unclaimed user too');
  assert.equal(credited.length, 0, 'nothing funded');
  assert.equal(claim.isNamespace(r.scopedCap), true);
});

test('signIn: idempotent re-sign-in → same namespace, funded only ONCE', async () => {
  const { claim, minted, credited } = mkClaim();
  const a = await claim.signIn({ did: 'did:plc:alice' });
  const b = await claim.signIn({ did: 'did:plc:alice' });
  assert.equal(a.scopedCap, b.scopedCap, 'stable namespace across sign-ins');
  assert.equal(minted.length, 1, 'minted once');
  assert.equal(credited.length, 1, 'funded once');
  assert.equal(b.granted, 0, 're-sign-in funds nothing new');
  assert.equal(claim.hasClaimed('did:plc:alice'), true);
});

test('signIn: an unclaimed user who BECOMES eligible later gets funded on next sign-in', async () => {
  // first sign-in ineligible (stranger), then a sign-in for an eligible DID — each tracked independently
  const { claim, credited } = mkClaim();
  const s = await claim.signIn({ did: 'did:plc:stranger' });
  assert.equal(s.granted, 0);
  const c = await claim.signIn({ did: 'did:plc:carol' }); // carol is on the allow-list
  assert.equal(c.eligible, true); assert.equal(c.granted, 1_000_000, 'eligible sign-in funds');
  assert.equal(credited.length, 1);
});

test('signIn: rejects a non-DID identity (must be OAuth-proven)', async () => {
  const { claim } = mkClaim();
  const r = await claim.signIn({ did: 'alice.bsky.social' });
  assert.equal(r.ok, false);
});
