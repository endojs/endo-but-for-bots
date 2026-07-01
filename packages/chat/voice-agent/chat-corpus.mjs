// chat-corpus.mjs — a READ-ONLY, SANITIZED view over the WHOLE chat corpus (every per-cap
// store file under VOICE_STATE_DIR/chats). It exists for SCHEDULED self-eval runs (the
// weekly "self-eval → eval-gated improvement" agent): a scheduled run has no live-chat
// ctx.app, and the root `app` power is META (never granted to scheduled agents), so the
// corpus was unreachable from exactly the place that needs to study it. This module reads
// the store files directly instead.
//
// Safety properties (the reason this is grantable while `app` is not):
//   • WRITE-FREE — fs reads only; there is no verb here that can mutate a chat.
//   • SANITIZE IS BUILT IN — readChatSanitized launders emails, phone numbers, and any
//     ≥16-char hex run (swissnums, tokens, eth addresses) into stable per-read
//     placeholders BEFORE the text leaves this module (cap-hygiene: a corpus read can
//     never hand an agent a raw credential).
//   • HARD SIZE CLAMP — transcripts are middle-truncated (default ~8000 chars) so a
//     corpus read can't blow the context window of a small orchestrator model.
import fs from 'node:fs';
import path from 'node:path';

import { VOICE_STATE_DIR } from './field-config.mjs';

const DEFAULT_CHATS_DIR = path.join(VOICE_STATE_DIR, 'chats');
const DEFAULT_MAX_CHARS = 8000;

// Fresh regexes per call — a shared (and possibly harden()'d) /g regex is a lastIndex
// hazard under SES (see the field-capture String.replace crash); never module-scope these.
const emailRe = () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const hexRe = () => /\b(?:0x)?[0-9a-fA-F]{16,}\b/g; // swissnums, API tokens, eth addresses
const phoneRe = () => /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

// makeSanitizer() → sanitize(text). Placeholders are STABLE within one sanitizer (the
// same email is always <email-1>), so a laundered transcript stays coherent for a judge.
export const makeSanitizer = () => {
  const seen = new Map(); // `${kind}:${match}` → placeholder
  const counts = { email: 0, hex: 0, phone: 0 };
  const sub = kind => m => {
    const key = `${kind}:${m}`;
    if (!seen.has(key)) { counts[kind] += 1; seen.set(key, `<${kind}-${counts[kind]}>`); }
    return seen.get(key);
  };
  // order matters: whole emails first (their local parts can look hex-ish), then hex
  // runs (which also eat 16+ pure-digit sequences — fine, still sanitized), then phones.
  return text => String(text ?? '')
    .replace(emailRe(), sub('email'))
    .replace(hexRe(), sub('hex'))
    .replace(phoneRe(), sub('phone'));
};
harden(makeSanitizer);

// clampMiddle(text, maxChars) — hard size clamp that keeps the head (the goal) and the
// tail (the outcome) and cuts the middle; the weekly eval cares about exactly those ends.
export const clampMiddle = (text, maxChars = DEFAULT_MAX_CHARS) => {
  const s = String(text ?? '');
  const max = Math.max(200, Math.round(Number(maxChars) || DEFAULT_MAX_CHARS));
  if (s.length <= max) return s;
  const marker = `\n…[${s.length - max} chars truncated]…\n`;
  const keep = Math.max(100, max - marker.length);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return s.slice(0, head) + marker + s.slice(s.length - tail);
};
harden(clampMiddle);

const readStores = dir => {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const stores = [];
  for (const f of files) {
    try { stores.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip an unparsable store */ }
  }
  return stores;
};

// listAllChats({ dir }) → [{ id, title, ts, msgCount }] across EVERY store file (not
// per-cap), newest first; deleted chats excluded; duplicate ids collapsed.
export const listAllChats = ({ dir = DEFAULT_CHATS_DIR } = {}) => {
  const out = []; const seen = new Set();
  for (const store of readStores(dir)) {
    const deleted = new Set(Array.isArray(store.deleted) ? store.deleted : []);
    for (const c of (Array.isArray(store.chats) ? store.chats : [])) {
      if (!c || !c.id || seen.has(c.id) || deleted.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: String(c.id), title: String(c.title || ''), ts: Number(c.ts) || 0, msgCount: (((store.tx || {})[c.id]) || []).length });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return harden(out);
};
harden(listAllChats);

// readChatSanitized({ id, maxChars, dir }) → { ok, id, title, ts, msgCount, transcript,
// truncated } — the transcript ALWAYS passes the sanitize pass and the size clamp; there
// is no raw-read variant in this module by design.
export const readChatSanitized = ({ id, maxChars = DEFAULT_MAX_CHARS, dir = DEFAULT_CHATS_DIR } = {}) => {
  const want = String(id || '');
  if (!want) return harden({ ok: false, error: 'need a chat id (from listChats)' });
  for (const store of readStores(dir)) {
    const tx = (store.tx || {})[want];
    const meta = (Array.isArray(store.chats) ? store.chats : []).find(c => c && c.id === want);
    if (!tx && !meta) continue;
    const sanitize = makeSanitizer();
    const lines = (Array.isArray(tx) ? tx : []).map(m => {
      const text = typeof (m && m.text) === 'string' ? m.text : JSON.stringify((m && m.text) ?? '');
      return `${(m && m.who) || '?'}: ${text}`;
    });
    const full = sanitize(lines.join('\n\n'));
    const transcript = clampMiddle(full, maxChars);
    return harden({ ok: true, id: want, title: sanitize(String((meta && meta.title) || '')), ts: meta ? (Number(meta.ts) || 0) : null, msgCount: lines.length, transcript, truncated: transcript.length < full.length });
  }
  return harden({ ok: false, error: `no chat "${want}" in the corpus` });
};
harden(readChatSanitized);
