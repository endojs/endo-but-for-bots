// @ts-check

// security-pattern.js — INCREMENT 2 of trusted-in-untrusted Secure UI: making a forgery RECOGNIZABLE.
//
// `sealComponent` (compartment.js) makes trusted content unreachable and unforgeable: an untrusted
// child can place it, parameterize it within a declared contract, and learn nothing. What it cannot do
// is stop untrusted code DRAWING ITS OWN convincing imitation — the "Impersonation" attack in dan's
// vault note (`trusted-in-untrusted Secure UI.md`): "A malicious context could render a field as if it
// were a trusted element … Indicating the user has received funds they have not received."
//
// The note's own mitigation is a SECURITY PATTERN, and the reason it works is the asymmetry sealing
// already bought us: the pattern is derived from a secret the untrusted context CANNOT OBSERVE, and it
// is only ever rendered inside a sealed component, whose output that context cannot read. So the
// attacker is drawing blind. They can draw a badge; they cannot draw YOUR badge.
//
// This is the old bank-SiteKey / SSH-randomart idea, with the property those lack: here the attacker
// genuinely has no read path to the secret, because the confinement boundary is real. (SiteKey failed
// in the field largely because a phishing site COULD fetch the real image; a confined compartment
// cannot — it has no network, no DOM, no globals beyond its endowments.)
//
// In Ka-Ping Yee's terms (Secure UI reading list): sealing buys FAITHFUL — what you see is what the
// trusted party rendered. The pattern buys UNSPOOFABLE / IDENTIFIABLE — you can tell it apart from an
// imitation. Trusted path needs both halves.
//
// THE SECRET'S ONE JOB. `secret` is used for nothing but deriving this rendering. It must not be reused
// as a credential: the whole design POINT is that its derived form is shown to the user constantly, so
// treat the pattern as public-to-the-user and the secret as valuable only because it is unobserved.

import { h } from 'preact';
import { sealComponent } from './compartment.js';

// Deliberately small, high-contrast sets. Recognition is a HUMAN act performed hundreds of times a
// day at a glance — a pattern nobody can recall is not a security control, and an attacker guessing
// blind faces the product of these, which is ample when they get no feedback about a wrong guess.
const GLYPHS = [
  '◆',
  '●',
  '▲',
  '■',
  '★',
  '✦',
  '♦',
  '⬟',
  '⬢',
  '◈',
  '✱',
  '❖',
  '▼',
  '⬣',
  '◉',
  '✶',
];
const WORDS = [
  'amber',
  'basalt',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'glass',
  'harbor',
  'indigo',
  'juniper',
  'kelp',
  'lantern',
  'meadow',
  'nimbus',
  'onyx',
  'pillar',
  'quartz',
  'ridge',
  'saffron',
  'thistle',
  'umber',
  'violet',
  'willow',
  'xenon',
  'yarrow',
  'zephyr',
  'anchor',
  'bramble',
  'cinder',
  'dune',
  'elder',
  'flint',
];

// FNV-1a. NOT a security hash and not asked to be one: the secret is never revealed, and this only has
// to spread inputs evenly across the tables above. If the pattern ever becomes a value an attacker can
// OBSERVE, the right fix is to stop showing it — not to make this stronger.
const hash32 = (str, seed) => {
  let hv = (2_166_136_261 ^ seed) >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    hv ^= s.charCodeAt(i);
    hv = Math.imul(hv, 16_777_619) >>> 0;
  }
  return hv >>> 0;
};

/**
 * Derive the user's visible pattern from their secret. Pure + stable: the same secret always yields
 * the same badge, which is the entire basis for recognition.
 *
 * @param {string} secret The user's unobserved pattern secret.
 * @returns {{glyph: string, words: string[], hue: number, hue2: number, phrase: string}}
 */
export function derivePattern(secret) {
  const s = String(secret == null ? '' : secret);
  const glyph = GLYPHS[hash32(s, 1) % GLYPHS.length];
  const w1 = WORDS[hash32(s, 2) % WORDS.length];
  let w2 = WORDS[hash32(s, 3) % WORDS.length];
  if (w2 === w1) w2 = WORDS[(hash32(s, 3) + 1) % WORDS.length]; // never "amber amber" — it reads as a bug
  const hue = hash32(s, 4) % 360;
  const hue2 = (hue + 140 + (hash32(s, 5) % 80)) % 360; // a companion hue that stays distinguishable
  return { glyph, words: [w1, w2], hue, hue2, phrase: `${w1} ${w2}` };
}

/**
 * Mint the SEALED trust badge: a component an untrusted child may place, but which only the host can
 * render — and which carries the user's pattern, so the user can tell it from an imitation.
 *
 * The secret is captured in this closure. It is never a param, never reaches the placeholder, and
 * never appears in anything handed to child code.
 *
 * PLACEMENT IS THE CONTRACT: hand this to a confined child and let the child place it. Rendered
 * directly by host code it yields nothing — the invocation token is armed for the diff Preact drives
 * across the confinement boundary, and host code never needs a seal anyway (it can call its own
 * function). Pinned by a test so this is a documented contract, not a surprise.
 *
 * @param {string} secret The user's pattern secret (from `getOrCreatePatternSecret`).
 * @param {{label?: string}} [opts] `label`: default text when the child supplies none.
 * @returns {Function} A sealed placeholder. The child may pass `text` (a primitive) — its own words,
 *   rendered BESIDE the pattern, never inside it.
 */
export function sealPatternBadge(secret, opts = {}) {
  const pattern = derivePattern(secret);
  const defaultLabel = String(opts.label == null ? '' : opts.label);
  return sealComponent(
    ({ text }) =>
      h(
        'span',
        {
          class: 'secure-badge',
          // Inline style, because this must not be restyleable by the surrounding (untrusted) context's
          // stylesheet — an attacker who could recolour or hide the badge could make a forgery match, or
          // make the real one disappear.
          style:
            `display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;` +
            `background:hsl(${pattern.hue} 70% 22%);color:hsl(${pattern.hue2} 90% 82%);` +
            `border:1px solid hsl(${pattern.hue2} 70% 45%);font-size:12px;font-weight:600;`,
          title: `Your security pattern: ${pattern.glyph} ${pattern.phrase}. If this does not match, do not trust this prompt.`,
        },
        h('span', { 'aria-hidden': 'true' }, pattern.glyph),
        h('span', null, pattern.phrase),
        text || defaultLabel
          ? h(
              'span',
              { style: 'opacity:.85;font-weight:400' },
              String(text || defaultLabel),
            )
          : null,
      ),
    { params: ['text'] },
  );
}

/**
 * Get (or create) the user's pattern secret from a storage-like object.
 *
 * Kept OUT of the sealed component on purpose: creation is host policy, not rendering. Storage must be
 * somewhere confined children cannot reach — under SES lockdown a compartment has no ambient globals,
 * so app-origin `localStorage` qualifies.
 *
 * @param {{getItem: Function, setItem: Function}} storage e.g. `localStorage`.
 * @param {() => string} randomHex Host-supplied randomness (e.g. crypto.getRandomValues → hex).
 * @param {string} [key]
 * @returns {string} the secret — hand it ONLY to sealPatternBadge.
 */
export function getOrCreatePatternSecret(
  storage,
  randomHex,
  key = 'secure-ui-pattern-secret',
) {
  try {
    const existing = storage.getItem(key);
    if (existing) return String(existing);
    const fresh = String(randomHex());
    storage.setItem(key, fresh);
    return fresh;
  } catch {
    // Storage denied (private mode, quota, a locked-down store). Returning a per-session secret keeps
    // the badge WORKING and self-consistent within the session — a badge that fails open to "no
    // pattern" would train the user to accept a pattern-less prompt, which is the forgery.
    return String(randomHex());
  }
}
