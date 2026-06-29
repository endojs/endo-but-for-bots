// bluesky-raindrop.mjs — "Invite Bluesky users by Raindrop".
//
// dan curates a Raindrop.io collection of Bluesky profile bookmarks (bsky.app/profile/<handle>). This module
// reads that collection, mints each of those people a STABLE per-user NAMESPACE cap (via the membership seam in
// invite-policy.mjs — re-running never re-mints, the same person keeps the same space), and delivers each their
// own invite link over Bluesky (a private DM) — or, if asked, a public @mention with NO link (cap-safe), or
// nothing at all (mint only; dan hands out links himself).
//
// CAP HYGIENE (dan's red line — never render/persist a swissnum to DOM/log/chat-as-app):
//   - The invite URL (which carries #cap=<swiss>) is built HERE and put ONLY into the one private DM addressed to
//     its designated recipient. It is NEVER returned to the agent/LLM, never console-logged, never fed to the feed,
//     never stored in this module's state. (Delivering an invite link in a private DM is the same trust model as
//     emailing one — the existing `kazputer`/`email` powers already do this. DMs are not E2E, so this is the
//     documented hand-off, no worse than email; `mention` mode avoids it entirely.)
//   - Our state file records only (did → { handle, invitedAt, delivered }). The identity→cap mapping lives in the
//     invite-policy registry (hashed), exactly like every other membership.
//
// Plain Node (fs/crypto + global fetch) so it imports from the SES server and runs standalone in tests.
// Credentials live in ~/.config/field-agent/bluesky-raindrop.json, NEVER in code or chat:
//   {
//     "raindrop":   { "token": "<raindrop test token>" },
//     "bluesky":    { "identifier": "you.bsky.social", "appPassword": "xxxx-xxxx-xxxx-xxxx" },
//     "deliver":    "dm",                 // default delivery: "dm" | "mention" | "none"
//     "collection": "Bluesky invites",    // optional default collection (title or numeric id)
//     "messageTemplate": "..."            // optional; {url} and {handle} are substituted
//   }
// The Bluesky app password MUST be created with "Allow access to your direct messages" for `dm` mode to work.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Plain-node fallback so this imports + runs without SES lockdown (tests, CLI). No-op under the SES server.
if (typeof globalThis.harden !== 'function') globalThis.harden = x => Object.freeze(x);

const RAINDROP = 'https://api.raindrop.io';
const PDS = 'https://bsky.social';
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';
const BSKY_PROFILE = /^https?:\/\/bsky\.app\/profile\/([^/?#]+)/i;

const DEFAULT_TEMPLATE =
  "You're invited to my Agent C — your own private, capability-secured space. Open your link to claim it: {url}";

// UTF-8 byte length (Bluesky facet offsets are byte offsets, not JS string indices).
const utf8len = s => new TextEncoder().encode(s).length;
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── Bluesky client ─────────────────────────────────────────────────────────────────────────────────────────
const makeBluesky = ({ identifier, appPassword }, doFetch) => {
  let session = null; // { accessJwt, did, handle } — created once, reused for the whole run
  const login = async () => {
    if (session) return session;
    const res = await doFetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    if (!res.ok) throw new Error(`bluesky login ${res.status}: ${(await res.text()).slice(0, 200)}`);
    session = await res.json();
    return session;
  };
  const xrpc = async (method, body, { proxy = false } = {}) => {
    const s = await login();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.accessJwt}` };
    if (proxy) headers['atproto-proxy'] = CHAT_PROXY;
    const res = await doFetch(`${PDS}/xrpc/${method}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  const resolveDid = async handleOrDid => {
    if (handleOrDid.startsWith('did:')) return handleOrDid;
    const url = new URL(`${PUBLIC_APPVIEW}/xrpc/com.atproto.identity.resolveHandle`);
    url.searchParams.set('handle', handleOrDid);
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`resolveHandle ${handleOrDid} ${res.status}`);
    return (await res.json()).did;
  };
  return {
    login,
    resolveDid,
    sendDM: async (did, text) => {
      const { convo } = await xrpc('chat.bsky.convo.getConvoForMembers', { members: [did] }, { proxy: true });
      return xrpc('chat.bsky.convo.sendMessage', { convoId: convo.id, message: { text } }, { proxy: true });
    },
    postMention: async (handle, did, text) => {
      const mention = `@${handle}`;
      const full = `${mention} ${text}`;
      const byteStart = 0;
      const byteEnd = utf8len(mention);
      return xrpc('com.atproto.repo.createRecord', {
        repo: (await login()).did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: full,
          createdAt: new Date().toISOString(),
          facets: [{ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#mention', did }] }],
        },
      });
    },
  };
};

/**
 * @param {object} opts
 * @param {string} opts.configFile      ~/.config/field-agent/bluesky-raindrop.json
 * @param {string} opts.stateFile       where delivery state (did→status) is recorded
 * @param {object} opts.invitePolicies  makeInvitePolicies(...) — the membership seam
 * @param {string} opts.policyName      the membership policy name to mint under
 * @param {string[]} opts.ring          the least-privilege starter ring each invitee gets
 * @param {string} opts.baseUrl         e.g. https://agentc.chu.vmkqx.com — for building #cap= links
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 */
export const makeBlueskyRaindropInviter = ({
  configFile,
  stateFile,
  invitePolicies,
  policyName = 'Bluesky invites',
  ring,
  baseUrl,
  fetchImpl,
  throttleMs = 4000, // pause between Bluesky deliveries (DM etiquette / rate-limit safety); 0 in tests
} = {}) => {
  const doFetch = fetchImpl || globalThis.fetch;
  const readCfg = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { invited: {} }; } };
  const writeState = d => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  };

  // Ensure the single membership policy these invites mint under exists; returns its id.
  const ensurePolicy = () => {
    const existing = invitePolicies.listPolicies().find(p => p.name === policyName);
    if (existing) return existing.id;
    return invitePolicies.createPolicy({ name: policyName, ring, auth: { kind: 'bluesky-raindrop' } }).id;
  };

  // What's configured vs. missing — drives the runbook so dan knows exactly what to paste.
  const status = () => {
    const cfg = readCfg();
    const missing = [];
    if (!cfg.raindrop?.token) missing.push('raindrop.token');
    if (!cfg.bluesky?.identifier || !cfg.bluesky?.appPassword) missing.push('bluesky.identifier + bluesky.appPassword');
    const st = readState();
    return harden({
      ok: missing.length === 0,
      configFile,
      raindrop: !!cfg.raindrop?.token,
      bluesky: { configured: !!(cfg.bluesky?.identifier && cfg.bluesky?.appPassword), identifier: cfg.bluesky?.identifier || null },
      deliver: cfg.deliver || 'dm',
      defaultCollection: cfg.collection || null,
      invitedCount: Object.keys(st.invited || {}).length,
      missing,
    });
  };

  const listCollections = async () => {
    const cfg = readCfg();
    if (!cfg.raindrop?.token) throw new Error('raindrop.token not configured — see bluesky-raindrop.json runbook');
    return harden(await makeRaindrop(cfg.raindrop.token, doFetch).listCollections());
  };

  // Resolve a collection id from a numeric id or a title.
  const resolveCollectionId = async (raindrop, want) => {
    if (want == null || want === '') throw new Error('no collection specified (pass a collection title/id, or set "collection" in config)');
    if (/^-?\d+$/.test(String(want))) return Number(want);
    const cols = await raindrop.listCollections();
    const hit = cols.find(c => c.title?.toLowerCase() === String(want).toLowerCase());
    if (!hit) throw new Error(`no Raindrop collection titled "${want}" (have: ${cols.map(c => c.title).join(', ').slice(0, 200)})`);
    return hit.id;
  };

  // Read the collection → unique Bluesky profiles (handle/DID), marking who's already been invited.
  const gather = async want => {
    const cfg = readCfg();
    if (!cfg.raindrop?.token) throw new Error('raindrop.token not configured');
    const raindrop = makeRaindrop(cfg.raindrop.token, doFetch);
    const collectionId = await resolveCollectionId(raindrop, want ?? cfg.collection);
    const items = await raindrop.getAll(collectionId);
    const seen = new Set();
    const profiles = [];
    for (const r of items) {
      const p = parseBskyProfile(r.link);
      if (!p || seen.has(p.id.toLowerCase())) continue;
      seen.add(p.id.toLowerCase());
      profiles.push({ ref: p.id, isDid: p.isDid, title: r.title || '' });
    }
    return { collectionId, total: items.length, profiles };
  };

  // DRY RUN — who WOULD be invited. No mint, no send. Safe to call freely.
  const preview = async ({ collection } = {}) => {
    const st = readState();
    const { collectionId, total, profiles } = await gather(collection);
    const users = profiles.map(p => ({
      ref: p.ref,
      title: p.title,
      // already-invited if this exact ref (or its resolved did, if we stored one) is in state
      alreadyInvited: Object.values(st.invited || {}).some(v => v.handle?.toLowerCase() === p.ref.toLowerCase()),
    }));
    return harden({ ok: true, collectionId, scanned: total, found: users.length, fresh: users.filter(u => !u.alreadyInvited).length, users });
  };

  // LIVE — mint a stable namespace per profile + deliver. Idempotent (redeem is stable; we skip already-delivered).
  const invite = async ({ collection, deliver, limit = 50, onlyFresh = true } = {}) => {
    const cfg = readCfg();
    const mode = deliver || cfg.deliver || 'dm';
    if (!['dm', 'mention', 'none'].includes(mode)) throw new Error(`bad deliver mode "${mode}" (dm|mention|none)`);
    if (mode !== 'none' && (!cfg.bluesky?.identifier || !cfg.bluesky?.appPassword)) {
      throw new Error('bluesky.identifier + bluesky.appPassword not configured — needed to deliver; use deliver:"none" to mint only');
    }
    const policyId = ensurePolicy();
    const bsky = mode === 'none' ? null : makeBluesky(cfg.bluesky, doFetch);
    const template = String(cfg.messageTemplate || DEFAULT_TEMPLATE);
    const { profiles } = await gather(collection);
    const st = readState();
    st.invited = st.invited || {};

    let minted = 0, delivered = 0;
    const skipped = [], errors = [];
    let count = 0;
    for (const p of profiles) {
      if (count >= limit) { skipped.push({ ref: p.ref, why: 'limit reached' }); continue; }
      const already = Object.values(st.invited).find(v => v.handle?.toLowerCase() === p.ref.toLowerCase());
      if (onlyFresh && already && already.delivered) { skipped.push({ ref: p.ref, why: 'already invited' }); continue; }
      count += 1;
      try {
        // resolve the DID (needed for delivery + as the stable membership identity)
        const did = bsky ? await bsky.resolveDid(p.ref) : (p.isDid ? p.ref : p.ref);
        // mint (or re-fetch) the stable per-user namespace cap for this identity
        const r = await invitePolicies.redeem(policyId, { identity: did, verify: () => true });
        if (!r.ok) { errors.push({ ref: p.ref, error: r.error || 'redeem failed' }); continue; }
        minted += 1;
        // CAP HYGIENE: this URL carries the swissnum. It goes ONLY into the private DM below — never returned/logged.
        const url = `${baseUrl}/#cap=${r.scopedCap}`;
        const text = template.replace(/\{url\}/g, url).replace(/\{handle\}/g, p.ref);
        let deliveredThis = false;
        if (mode === 'dm') { await bsky.sendDM(did, text); deliveredThis = true; await sleep(throttleMs); }
        else if (mode === 'mention') {
          // public post — NO link (a cap can never go in public). Just an @mention nudging them to claim.
          await bsky.postMention(p.ref.startsWith('did:') ? did : p.ref, did,
            "I've set up a private space for you on my Agent C — DM me and I'll send your invite link.");
          deliveredThis = true; await sleep(throttleMs);
        }
        if (deliveredThis) delivered += 1;
        // record delivery status only — NO swissnum/url persisted here
        st.invited[hash(did)] = { handle: p.ref, did, invitedAt: new Date().toISOString(), delivered: deliveredThis, mode };
        writeState(st);
      } catch (e) {
        errors.push({ ref: p.ref, error: String(e?.message || e).slice(0, 200) });
        if (/rate|429|RateLimit/i.test(String(e?.message || e))) { skipped.push({ ref: 'remaining', why: 'rate limited — stopping' }); break; }
      }
    }
    // NOTE the deliberate absence of any links in the return value (cap hygiene).
    return harden({ ok: true, mode, minted, delivered, skipped, errors, note: mode === 'none' ? 'minted only — links are in the Shares panel' : `${delivered} delivered over Bluesky (${mode})` });
  };

  return harden({ status, listCollections, preview, invite });
};
