// @ts-check

/**
 * An unspoofable trust badge — making a forgery RECOGNIZABLE.
 *
 * A confined component makes trusted content unreachable and unforgeable, but
 * it cannot stop untrusted code DRAWING ITS OWN convincing imitation of a
 * trusted element ("you have received funds"). The mitigation is a SECURITY
 * PATTERN: a per-user rendering derived from a secret the guest cannot
 * observe, shown only inside a confined component whose output the guest
 * cannot read. So the attacker draws blind — they can draw a badge, not YOUR
 * badge.
 *
 * This is the bank-SiteKey / SSH-randomart idea with the property those lack:
 * the guest genuinely has no read path to the secret, because the confinement
 * boundary is real (under SES lockdown a compartment has no network, no DOM,
 * no ambient globals). In Yee's terms, confinement buys FAITHFUL (what you see
 * is what the host rendered); the pattern buys UNSPOOFABLE. Trusted path needs
 * both.
 *
 * THE SECRET'S ONE JOB is to derive this rendering. Its derived form is shown
 * to the user constantly, so treat the pattern as public-to-the-user and the
 * secret as valuable only because it is unobserved. Never reuse it as a
 * credential.
 */

import { confineComponent } from '@endo/preact-container/compartment';

import { withPrimitiveParams, withLimitedCss } from './modifiers.js';
import { freeze } from './freeze.js';

// Small, high-contrast sets: recognition is a human act done at a glance, and
// a blind guesser faces the product of these with no feedback on a wrong try.
const GLYPHS = freeze([
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
]);
const WORDS = freeze([
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
]);

// FNV-1a — NOT a security hash and not asked to be one. The secret is never
// revealed; this only has to spread inputs across the tables above. If the
// pattern ever becomes observable, the fix is to stop showing it, not to
// strengthen this.
const hash32 = (str, seed) => {
  let hv = (0x811c_9dc5 ^ seed) >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    hv ^= s.charCodeAt(i);
    hv = Math.imul(hv, 0x0100_0193) >>> 0;
  }
  return hv >>> 0;
};

/**
 * Derive the user's visible pattern from their secret. Pure and stable: the
 * same secret always yields the same badge, which is the whole basis for
 * recognition.
 *
 * @param {string} secret The user's unobserved pattern secret.
 * @returns {{ glyph: string, words: [string, string], hue: number, hue2: number, phrase: string }}
 */
export const derivePattern = secret => {
  const s = String(secret == null ? '' : secret);
  const glyph = GLYPHS[hash32(s, 1) % GLYPHS.length];
  const w1 = WORDS[hash32(s, 2) % WORDS.length];
  let w2 = WORDS[hash32(s, 3) % WORDS.length];
  if (w2 === w1) w2 = WORDS[(hash32(s, 3) + 1) % WORDS.length]; // never "amber amber"
  const hue = hash32(s, 4) % 360;
  const hue2 = (hue + 140 + (hash32(s, 5) % 80)) % 360;
  return freeze({ glyph, words: [w1, w2], hue, hue2, phrase: `${w1} ${w2}` });
};
freeze(derivePattern);

/**
 * Get (or create) the user's pattern secret from a storage-like object.
 *
 * Creation is host policy, not rendering, so it lives OUT of the component.
 * Storage must be somewhere confined guests cannot reach — under lockdown a
 * compartment has no ambient globals, so app-origin `localStorage` qualifies.
 * On storage denial it fails to a per-session secret, never to "no pattern": a
 * badge that silently vanished would train the user to accept a pattern-less
 * prompt, which is the forgery.
 *
 * @param {{ getItem: (k: string) => (string | null), setItem: (k: string, v: string) => void }} storage
 * @param {() => string} randomHex Host randomness, e.g. crypto.getRandomValues → hex.
 * @param {string} [key]
 * @returns {string} The secret — hand it ONLY to `makePatternBadge`.
 */
export const getOrCreatePatternSecret = (
  storage,
  randomHex,
  key = 'preact-social-pattern-secret',
) => {
  try {
    const existing = storage.getItem(key);
    if (existing) return String(existing);
    const fresh = String(randomHex());
    storage.setItem(key, fresh);
    return fresh;
  } catch (_) {
    return String(randomHex());
  }
};
freeze(getOrCreatePatternSecret);

/**
 * Mint the sealed trust badge: a confined component a guest may place but only
 * the host can render, carrying the user's pattern so they can tell it from an
 * imitation.
 *
 * The secret is captured in this closure — never a prop, never in anything the
 * guest can read. The guest may pass `text` (its own words), rendered BESIDE
 * the pattern, never inside it, so it cannot borrow the pattern's authority.
 * `withPrimitiveParams` keeps `text` a primitive; `withLimitedCss` keeps the
 * guest from restyling or hiding the badge.
 *
 * @param {string} secret From `getOrCreatePatternSecret`.
 * @param {{ label?: string }} [opts] `label`: default text when the guest supplies none.
 * @returns {import('preact').FunctionComponent<{ text?: string }>} The badge.
 */
export const makePatternBadge = (secret, opts = {}) => {
  const pattern = derivePattern(secret);
  const defaultLabel = String(opts.label == null ? '' : opts.label);
  const badgeStyle =
    'display:inline-flex;align-items:center;gap:6px;padding:2px 8px;' +
    'border-radius:999px;font-size:12px;font-weight:600;' +
    `background:hsl(${pattern.hue} 70% 22%);` +
    `color:hsl(${pattern.hue2} 90% 82%);` +
    `border:1px solid hsl(${pattern.hue2} 70% 45%);`;

  return confineComponent(
    withLimitedCss(
      withPrimitiveParams(({ h }, { text }) => {
        const label = text != null && text !== '' ? String(text) : defaultLabel;
        return h(
          'span',
          {
            class: 'secure-badge',
            style: badgeStyle,
            title: `Your security pattern: ${pattern.glyph} ${pattern.phrase}. If this does not match, do not trust this prompt.`,
          },
          h('span', { 'aria-hidden': 'true' }, pattern.glyph),
          h('span', null, pattern.phrase),
          label
            ? h('span', { style: 'opacity:.85;font-weight:400' }, label)
            : null,
        );
      }),
    ),
    { name: 'PatternBadge', onError: opts.onError },
  );
};
freeze(makePatternBadge);
