// app-state.mjs — the field agent's window onto the app's OWN stateful aspects.
//
// Every conversation lives in one of three server-side stores: the per-cap chat bundle
// (regular chats, `{chats:[{id,title,ts}], tx:{id:[turns]}, updated}`), the voice-memo runs,
// and the ingested voice-notes (seed-chats). This module unifies them so the agent can
// list / read / RETITLE any conversation, plus a one-call summary of asks/feed/etc.
//
// The cap is bound + closed over by the caller (server.mjs) PER-REQUEST — it never reaches
// the agent's ctx (cap-hygiene). retitle() bumps the bundle's `updated` so the client adopts.
// Pure dependency injection (no hard-coded paths) → unit-testable with temp files.
import fs from 'node:fs';

import { writeJsonAtomic } from './write-json-atomic.mjs';

export const makeAppStore = ({ chatStorePath, readMemoRuns, writeMemoRuns, readSeedChats, writeSeedChats, readAsks, feedFile, withChatLock } = {}) => {
  // serialize per-cap bundle writes with the client's /chats/save so a retitle can't
  // clobber concurrently-saved turns/chats (and vice-versa). No lock injected → direct (tests).
  const lock = withChatLock || ((cap, fn) => fn());
  const readBundle = async cap => { try { return JSON.parse(await fs.promises.readFile(chatStorePath(cap), 'utf8')); } catch { return null; } };
  const clip = (s, n = 90) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // unified, recency-sorted list of every conversation (deduped: a bundle entry wins over its seed)
  const listChats = async cap => {
    const out = []; const bundle = cap ? await readBundle(cap) : null; const tx = (bundle && bundle.tx) || {};
    for (const c of (bundle?.chats || [])) { const m = tx[c.id] || []; out.push({ id: c.id, title: c.title || 'New chat', kind: 'chat', turns: m.length, ts: c.ts || 0, preview: clip((m[0] || {}).text) }); }
    for (const m of await readMemoRuns()) out.push({ id: m.id, title: m.title || 'voice memo', kind: 'voice-memo', turns: 2, ts: Date.parse(m.date) || 0, preview: clip(m.transcript) });
    const seen = new Set(out.map(x => x.id));
    for (const s of await readSeedChats()) if (!seen.has(s.id)) out.push({ id: s.id, title: s.title || 'voice note', kind: 'voice-note', turns: (s.tx || []).length || 2, ts: s.ts || 0, preview: clip(s.transcript) });
    return out.sort((a, b) => b.ts - a.ts);
  };

  // read one conversation's content (so the agent can decide a descriptive title, etc.)
  const readChat = async (cap, id) => {
    const i = String(id || '');
    const m = (await readMemoRuns()).find(r => r.id === i);
    if (m) return { id: i, title: m.title, kind: 'voice-memo', transcript: String(m.transcript || '').slice(0, 4000), answer: String(m.versions?.[m.versions.length - 1]?.answer || '').slice(0, 2000) };
    const bundle = cap ? await readBundle(cap) : null; const msgs = (bundle?.tx || {})[i];
    if (msgs) return { id: i, title: String((bundle.chats.find(c => c.id === i) || {}).title || ''), kind: 'chat', messages: msgs.map(x => ({ who: x.who, text: String(x.text || '').slice(0, 1500) })) };
    const s = (await readSeedChats()).find(x => x.id === i);
    if (s) return { id: i, title: s.title, kind: 'voice-note', transcript: String(s.transcript || '').slice(0, 4000), messages: (s.tx || []).map(x => ({ who: x.who, text: String(x.text || '').slice(0, 1500) })) };
    return { error: `no conversation with id "${i}"` };
  };

  // set a conversation's title across the right store(s); bumps the bundle's `updated` to force client adoption.
  const retitle = async (cap, id, title) => {
    const i = String(id || ''); const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!i || !t) return { ok: false, error: 'id and a non-empty title are required' };
    const changed = [];
    const memos = await readMemoRuns(); const m = memos.find(r => r.id === i); if (m && m.title !== t) { m.title = t; await writeMemoRuns(memos); changed.push('voice-memo'); }
    const seeds = await readSeedChats(); const s = seeds.find(x => x.id === i); if (s && s.title !== t) { s.title = t; await writeSeedChats(seeds); changed.push('voice-note'); }
    if (cap) {
      // re-read the FRESHEST bundle under the lock and patch only this title — never write back a
      // stale snapshot (which would drop turns/chats the client saved concurrently).
      await lock(cap, async () => {
        const b = await readBundle(cap); const c = b && Array.isArray(b.chats) && b.chats.find(x => x.id === i);
        if (c && c.title !== t) { c.title = t; b.updated = Date.now(); try { writeJsonAtomic(chatStorePath(cap), b); changed.push('chat'); } catch { /* best effort */ } } // INT-2: atomic — a crash mid-retitle can't torn the cap's history
      });
    }
    return { ok: changed.length > 0, id: i, title: t, updated: changed, note: changed.length ? 'Title updated — it appears on the next sync/refresh.' : `No conversation found with id "${i}".` };
  };

  const summary = async cap => {
    const bundle = cap ? await readBundle(cap) : null;
    let feed = []; try { feed = (JSON.parse(await fs.promises.readFile(feedFile, 'utf8')).entries) || []; } catch { feed = []; }
    const openAsks = (readAsks ? readAsks() : []).filter(a => a.status !== 'done');
    return { chats: (bundle?.chats || []).length, voiceMemos: (await readMemoRuns()).length, voiceNotes: (await readSeedChats()).length, openAsks: openAsks.length, feedItems: feed.length };
  };

  return harden({ listChats, readChat, retitle, summary });
};
harden(makeAppStore);
