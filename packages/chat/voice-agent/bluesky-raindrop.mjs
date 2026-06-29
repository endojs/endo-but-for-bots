// bluesky-raindrop.mjs — the Raindrop side of "Sign in with Bluesky → claim credits".
//
// dan curates a Raindrop.io collection of Bluesky profile bookmarks (bsky.app/profile/<handle-or-did>). That
// collection is the ELIGIBILITY ALLOW-LIST: anyone may sign in with Bluesky, but only a handle/DID present in the
// collection can claim a credit allowance (see bluesky-claim.mjs). This module turns the collection into a fast
// lookup of eligible identities — it does NOT message anyone (pull, not push).
//
// Identity matching: AT-Protocol OAuth proves a stable DID; bookmarks may be handles OR DIDs. So we resolve every
// bookmarked handle to its DID (public, unauthenticated com.atproto.identity.resolveHandle — no app password, we
// never act on anyone's behalf) and match on DID, falling back to a case-folded handle match.
//
// Plain Node (fs + global fetch) so it imports from the SES server and runs standalone in tests. The Raindrop
// token lives in ~/.config/field-agent/bluesky-raindrop.json, NEVER in code or chat:
//   { "raindrop": { "token": "<raindrop test token>" }, "collection": "Bluesky invites" }

import fs from 'node:fs';

// Plain-node fallback so this imports + runs without SES lockdown (tests, CLI). No-op under the SES server.
if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const RAINDROP = 'https://api.raindrop.io';
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const BSKY_PROFILE = /^https?:\/\/bsky\.app\/profile\/([^/?#]+)/i;

// Pull a handle-or-DID out of a bsky.app/profile/<x> bookmark link.
export const parseBskyProfile = url => {
  const m = String(url || '').match(BSKY_PROFILE);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (!id || id === 'profile') return null;
  return { id, isDid: id.startsWith('did:') };
};

// ── Raindrop client ────────────────────────────────────────────────────────────────────────────────────────
const makeRaindrop = (token, doFetch) => {
  const call = async (pathname, params) => {
    const url = new URL(`${RAINDROP}${pathname}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`raindrop ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    listCollections: async () => {
      const [root, kids] = await Promise.all([
        call('/rest/v1/collections'),
        call('/rest/v1/collections/childrens').catch(() => ({ items: [] })),
      ]);
      return [...(root.items || []), ...(kids.items || [])].map(c => ({ id: c._id, title: c.title, count: c.count }));
    },
    // Page through a collection (perpage max 50, page is 0-indexed) until we have `count` items.
    getAll: async collectionId => {
      const items = [];
      for (let page = 0; page < 100; page += 1) {
        const { items: batch = [], count = 0 } = await call(`/rest/v1/raindrops/${collectionId}`, { perpage: 50, page });
        items.push(...batch);
        if (!batch.length || items.length >= count) break;
      }
      return items;
    },
  };
};

/**
 * @param {object} opts
 * @param {string} opts.configFile  ~/.config/field-agent/bluesky-raindrop.json (raindrop token + default collection)
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @param {number} [opts.cacheMs]  how long an eligibility snapshot is reused (default 5 min)
 */
export const makeBlueskyEligibility = ({ configFile, fetchImpl, cacheMs = 5 * 60 * 1000, now = () => Date.now() } = {}) => {
  const doFetch = fetchImpl || globalThis.fetch;
  const readCfg = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };

  const status = () => {
    const cfg = readCfg();
    return harden({ configured: !!cfg.raindrop?.token, configFile, defaultCollection: cfg.collection || null });
  };

  const listCollections = async () => {
    const cfg = readCfg();
    if (!cfg.raindrop?.token) throw new Error('raindrop.token not configured — see the runbook');
    return harden(await makeRaindrop(cfg.raindrop.token, doFetch).listCollections());
  };

  const resolveCollectionId = async (raindrop, want) => {
    if (want == null || want === '') throw new Error('no collection specified (set "collection" in config, or pass one)');
    if (/^-?\d+$/.test(String(want))) return Number(want);
    const cols = await raindrop.listCollections();
    const hit = cols.find(c => c.title?.toLowerCase() === String(want).toLowerCase());
    if (!hit) throw new Error(`no Raindrop collection titled "${want}"`);
    return hit.id;
  };

  // Resolve a bookmarked handle to its DID (public API; no auth). DIDs pass through unchanged.
  const resolveDid = async ref => {
    if (ref.startsWith('did:')) return ref;
    try {
      const url = new URL(`${PUBLIC_APPVIEW}/xrpc/com.atproto.identity.resolveHandle`);
      url.searchParams.set('handle', ref);
      const res = await doFetch(url);
      if (!res.ok) return null;
      return (await res.json()).did || null;
    } catch { return null; }
  };

  // Build the eligible-identity snapshot from the collection: a Set of DIDs + a Set of case-folded handles.
  let cache = null;
  const build = async want => {
    const cfg = readCfg();
    if (!cfg.raindrop?.token) throw new Error('raindrop.token not configured');
    const raindrop = makeRaindrop(cfg.raindrop.token, doFetch);
    const collectionId = await resolveCollectionId(raindrop, want ?? cfg.collection);
    const items = await raindrop.getAll(collectionId);
    const handles = new Set();
    const refs = [];
    for (const r of items) {
      const p = parseBskyProfile(r.link);
      if (!p) continue;
      if (p.isDid) refs.push(p.id);
      else { handles.add(p.id.toLowerCase()); refs.push(p.id); }
    }
    const dids = new Set();
    // resolve handles → DIDs (in parallel, best-effort) so we can match the OAuth'd DID
    await Promise.all([...new Set(refs)].map(async ref => { const d = await resolveDid(ref); if (d) dids.add(d); }));
    return { collectionId, dids, handles, count: refs.length };
  };

  const snapshot = async ({ collection, fresh = false } = {}) => {
    if (!fresh && cache && (now() - cache.at) < cacheMs && cache.collection === (collection ?? null)) return cache.snap;
    const snap = await build(collection);
    cache = { at: now(), collection: collection ?? null, snap };
    return snap;
  };

  // Is this proven identity eligible? Match on DID first, then case-folded handle.
  const isEligible = async ({ did, handle, collection } = {}) => {
    const snap = await snapshot({ collection });
    if (did && snap.dids.has(did)) return true;
    if (handle && snap.handles.has(String(handle).toLowerCase())) return true;
    return false;
  };

  // Dry-run view of who is eligible (for an admin/preview surface).
  const preview = async ({ collection } = {}) => {
    const snap = await snapshot({ collection, fresh: true });
    return harden({ ok: true, collectionId: snap.collectionId, scanned: snap.count, eligibleDids: snap.dids.size, eligibleHandles: [...snap.handles] });
  };

  return harden({ status, listCollections, isEligible, preview, snapshot });
};
