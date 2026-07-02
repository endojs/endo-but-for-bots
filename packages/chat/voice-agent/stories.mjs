// stories.mjs — the "🪄 Magic Stories" store: sanitized, review-gated showcase artifacts of flows this
// harness made possible (MAGIC-STORIES-1). dan (2026-07-02): "a fun-filled gallery of interesting stories
// sanitized from identity implications representing different flows made possible by this system —
// especially ones that leverage the object-capability, multi-hop delegation, and composition qualities."
//
// Lifecycle:  ⭐ nominate → SANITIZE (mandatory, at write) → candidate (needs review) → dan PUBLISHES → gallery.
//
// CAP-HYGIENE IS THE POINT (these are SHAREABLE artifacts): a story must be PROVABLY free of swissnums / #caps
// / identity before it can be published. Two enforcement layers:
//   1. addCandidate() SANITIZES every string (title/why + the whole flow shape) BEFORE persistence — never at
//      render. It reuses chat-corpus's makeSanitizer (emails / phones / ≥16-hex tokens → stable placeholders)
//      and adds the app's cap-SHAPE scrub (#cap=/#k=/#agent= links, bare 32-hex swissnums) + social @handles.
//   2. publishStory() is a HARD GATE: it re-scans the stored candidate with findIdentityLeaks and REFUSES to
//      publish if ANY residual email / phone / hex-run / swissnum / #cap link / @handle remains. So the set of
//      PUBLISHED stories is, by construction, free of the identity shapes we can detect. (Free-text personal
//      names that match no pattern are the residual risk the human review gate + an optional local-LLM pass
//      cover — see the collector route.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { makeSanitizer } from './chat-corpus.mjs';
import { writeJsonAtomic } from './write-json-atomic.mjs';

const file = () => process.env.STORIES_STORE || path.join(os.homedir(), '.local/state/field-agent/stories.json');
const now = () => new Date().toISOString();
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { items: [] }; } };
const save = s => { try { writeJsonAtomic(file(), s, { pretty: true }); } catch { /* best effort */ } return s; }; // INT-1: torn-write-safe

// The ocap qualities a story can demonstrate — the marquee ones (delegation/composition) first. These are the
// "what made this possible" facets the gallery surfaces; unknown values fall back to 'other'.
export const STORY_QUALITIES = harden([
  'multi-hop-delegation', 'composition', 'revocation', 'confinement', 'attenuation', 'paid-capability', 'other',
]);
const normQuality = q => (STORY_QUALITIES.includes(String(q || '')) ? String(q) : 'other');

// ── the SANITIZER (mandatory, deterministic) ──────────────────────────────────────────────────────────────
// Fresh regexes per call — a shared /g regex is a lastIndex hazard under SES (see field-capture crash). These
// mirror server.mjs scrubCaps (cap SHAPES) + a social-@handle scrub, layered on chat-corpus's makeSanitizer.
const capLinkRe = () => /#(?:cap|k|agent)=[\w-]{8,}/g;
const swissnumRe = () => /\b[0-9a-f]{32}\b/g; // bare 32-hex (a raw swissnum in free text)
// social handle: @word (optionally dotted like a bluesky handle), NOT an npm scope (@scope/pkg) and NOT the
// tail of an email (emails are eaten first by makeSanitizer).
const handleRe = () => /(^|[\s([{"'>])@([A-Za-z0-9][\w.-]{1,29})(?![\w./-])/g;

// sanitizeText(text) → text with emails/phones/≥16-hex → placeholders, cap links + swissnums → «redacted»,
// social handles → «handle». Stable within one sanitizer instance (pass one in to keep placeholders coherent
// across a whole story's many strings).
export const sanitizeText = (text, sanitizer) => {
  const sanitize = sanitizer || makeSanitizer();
  return sanitize(String(text ?? ''))
    .replace(capLinkRe(), m => `${m.split('=')[0]}=«redacted»`)
    .replace(swissnumRe(), '«swissnum»')
    .replace(handleRe(), (_m, pre) => `${pre}«handle»`);
};
harden(sanitizeText);

// deep-sanitize an arbitrary JSON value (the flow shape): every string is laundered; structure is preserved.
// One shared sanitizer instance so the same email becomes the same <email-1> everywhere in the story.
export const sanitizeValue = (value, sanitizer) => {
  const sanitize = sanitizer || makeSanitizer();
  const walk = v => {
    if (typeof v === 'string') return sanitizeText(v, sanitize);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return walk(value);
};
harden(sanitizeValue);

// sanitizeStory(story) → a copy with title/why/quality + flow fully laundered (one shared sanitizer).
export const sanitizeStory = story => {
  const s = story || {};
  const sanitizer = makeSanitizer();
  return {
    ...s,
    title: sanitizeText(s.title || '', sanitizer).slice(0, 140),
    why: sanitizeText(s.why || '', sanitizer).slice(0, 400),
    quality: normQuality(s.quality),
    flow: sanitizeValue(s.flow || null, sanitizer),
  };
};
harden(sanitizeStory);

// ── the LEAK DETECTOR (the publish gate's teeth) ────────────────────────────────────────────────────────────
// walk every string in the artifact and report the identity SHAPES that must never reach a published story.
const leakProbes = () => ([
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'hex', re: /\b(?:0x)?[0-9a-fA-F]{16,}\b/ },
  { kind: 'phone', re: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
  { kind: 'cap-link', re: /#(?:cap|k|agent)=[\w-]{8,}/ },
  { kind: 'handle', re: /(?:^|[\s([{"'>])@[A-Za-z0-9][\w.-]{1,29}(?![\w./-])/ },
]);
const collectStrings = (v, out) => {
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) collectStrings(v[k], out); }
};

// findIdentityLeaks(story) → [{ kind, sample }] of residual identity shapes. Empty === provably clean of the
// shapes we detect. Runs over title/why/flow (NOT the internal id/status/owner bookkeeping).
export const findIdentityLeaks = story => {
  const s = story || {};
  const strings = [];
  collectStrings([s.title, s.why, s.flow], strings);
  const leaks = [];
  for (const str of strings) {
    for (const { kind, re } of leakProbes()) {
      const m = re.exec(str); // fresh regex (non-global) per probe — no lastIndex state
      if (m) leaks.push({ kind, sample: String(m[0]).trim().slice(0, 40) });
    }
  }
  return harden(leaks);
};
harden(findIdentityLeaks);

// ── the STORE ───────────────────────────────────────────────────────────────────────────────────────────────
// addCandidate({ title, why, quality, flow, by }) — SANITIZE then persist as a 'candidate' (needs review). The
// sanitizer runs unconditionally before the write; a raw personal detail never touches the store. Returns the
// id + how many identity shapes it scrubbed (so the collector can reassure the nominator).
export const addCandidate = ({ title, why, quality, flow, by } = {}) => {
  const t = String(title || '').trim();
  if (!t) return { ok: false, error: 'a story needs a title' };
  const clean = sanitizeStory({ title: t, why, quality, flow });
  // audit: what the sanitizer removed (compare pre/post leak scans on the RAW input).
  const before = findIdentityLeaks({ title: t, why, flow });
  const item = {
    id: `story-${crypto.randomBytes(4).toString('hex')}`,
    title: clean.title, why: clean.why, quality: clean.quality, flow: clean.flow,
    status: 'candidate', by: String(by || '').slice(0, 80), addedAt: now(),
  };
  const s = load(); s.items.push(item); save(s);
  return { ok: true, id: item.id, scrubbed: before.length };
};
harden(addCandidate);

// listStories({ status }) — render-safe rows (id/title/why/quality/status/flow/timestamps), newest first.
export const listStories = ({ status } = {}) => load().items
  .filter(i => !status || i.status === status)
  .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
  .map(i => ({ id: i.id, title: i.title, why: i.why, quality: i.quality, status: i.status, flow: i.flow || null, by: i.by || '', addedAt: i.addedAt, publishedAt: i.publishedAt || null }));
harden(listStories);

export const listPublished = () => listStories({ status: 'published' });
harden(listPublished);
export const listCandidates = () => listStories({ status: 'candidate' });
harden(listCandidates);

// publishStory(id) — THE REVIEW GATE. A candidate is never auto-published; promotion is a deliberate act. This
// re-scans the stored candidate and REFUSES if any identity shape remains (defense in depth over addCandidate's
// write-time sanitize) — so a story that is NOT sanitized CANNOT be published, by construction.
export const publishStory = id => {
  const s = load(); const it = s.items.find(x => x.id === String(id));
  if (!it) return { ok: false, error: 'no such story' };
  if (it.status === 'published') return { ok: true, id: it.id, alreadyPublished: true };
  const leaks = findIdentityLeaks(it);
  if (leaks.length) return { ok: false, error: 'refusing to publish: story still contains identity shapes', leaks };
  it.status = 'published'; it.publishedAt = now(); save(s);
  return { ok: true, id: it.id };
};
harden(publishStory);

// discardStory(id) — drop a candidate (or an unpublish/removal). Returns whether anything was removed.
export const discardStory = id => {
  const s = load(); const before = s.items.length;
  s.items = s.items.filter(i => i.id !== String(id));
  const removed = before - s.items.length;
  if (removed) save(s);
  return { ok: removed > 0, removed };
};
harden(discardStory);

export const storiesFile = file;
harden(storiesFile);
