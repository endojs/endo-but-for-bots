// @ts-check

/**
 * Stable identity for a designated party (designs/designation-by-object-not-id.md).
 *
 * Callers designate a party by passing THE PARTY OBJECT. This module is the seam that lets that
 * survive a primitives-only boundary without falling back to a global id.
 *
 * Sealed-component params are coerced to primitives on purpose — no capability may ride in on a param
 * (trusted-in-untrusted-secure-ui.md). That constraint is real, and per the pattern doc it is NOT a
 * licence to hand the untrusted side a raw id. So we mint an OPAQUE PER-BOUNDARY HANDLE:
 *
 *   · held in a WeakMap keyed by the party object — no global registry keyed by string;
 *   · unguessable (crypto random), so it cannot be forged by a caller who was never given the party;
 *   · meaningless outside this module, and never persisted or rendered.
 *
 * An id is GLOBAL and GUESSABLE. A handle is LOCAL and MINTED. The difference is the whole point.
 *
 * The second thing every party gets here is a stable SEED, which is what makes an UNNAMED party
 * consistently badged and coloured. That was impossible with string ids — one unknown string is
 * indistinguishable from another — and it falls out for free once identity lives on the object.
 * A party's mark therefore does NOT change when the operator names or renames them: the mark tracks
 * WHO, the name tracks what you call them.
 */

const identities = new WeakMap();
// handle -> WeakRef<party> (or a strong ref, on a runtime without WeakRef — see the fallback below).
// A strong Map here would defeat `identities` being a WeakMap: every party ever designated would be
// pinned alive for the module's lifetime, keyed off a handle nothing else still holds. WeakRef lets a
// party be collected once its last real holder drops it; `partyForHandle` treats a collected referent
// the same as an unminted handle. `finalize` below reclaims the now-dead Map entry itself, so a churn
// of many short-lived parties does not leave `byHandle` growing forever with empty WeakRefs.
const byHandle = new Map();
const hasWeakRef = typeof WeakRef === 'function';
const finalize =
  hasWeakRef && typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry(handle => byHandle.delete(handle))
    : null;

const randomHex = (n = 16) => {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(n);
    c.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  // No CSPRNG: still per-boundary and non-enumerable, but say so rather than pretending.
  let s = '';
  while (s.length < n * 2)
    s += Math.floor(Math.random() * 0xffff_ffff).toString(16);
  return s.slice(0, n * 2);
};

/**
 * Identity record for a party object, minted once and stable for the object's lifetime.
 *
 * @param {object} party Any object the caller already holds. Not a string.
 * @returns {{ handle: string, seed: string }}
 */
export const partyIdentity = party => {
  if (
    party === null ||
    (typeof party !== 'object' && typeof party !== 'function')
  ) {
    // A string here is exactly the mistake this module exists to prevent, so it fails loudly rather
    // than quietly minting an identity for a forgeable designator.
    throw new TypeError(
      'partyIdentity: designate a party by OBJECT, not by id (see designs/designation-by-object-not-id.md)',
    );
  }
  let rec = identities.get(party);
  if (!rec) {
    rec = { handle: randomHex(16), seed: randomHex(8) };
    identities.set(party, rec);
    byHandle.set(rec.handle, hasWeakRef ? new WeakRef(party) : party);
    if (finalize) finalize.register(party, rec.handle);
  }
  return rec;
};

/** The opaque token to hand across a primitives-only boundary. */
export const handleFor = party => partyIdentity(party).handle;

/**
 * Resolve a handle back to the party it was minted for. Returns undefined for anything not minted
 * here — a forged or copied-from-elsewhere string resolves to nothing — AND for a party that has
 * since been collected, which reads the same as "not minted" to every caller (there is no live party
 * to hand back either way).
 *
 * @param {string} handle
 */
export const partyForHandle = handle => {
  const key = String(handle || '');
  const ref = byHandle.get(key);
  if (!ref) return undefined;
  if (!hasWeakRef) return ref; // no WeakRef on this runtime: byHandle held a strong ref instead
  const party = ref.deref();
  if (!party) byHandle.delete(key); // beat the FinalizationRegistry callback to a stale read
  return party;
};

/**
 * Deterministic visual mark for a party, derived from its stable SEED — not from its name, so
 * naming or renaming never changes the mark, and an unnamed party is still consistently badged.
 *
 * @param {object} party
 * @returns {{ glyph: string, hue: number, color: string }}
 */
export const markFor = party => {
  const { seed } = partyIdentity(party);
  let hash = 0x811c_9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  // A WIDE alphabet: with 8 glyphs two parties collide constantly (observed), and the glyph is the
  // part a person recognises at a glance, so collisions there erode the affordance even when hue
  // differs. Independent bits for hue, so a glyph collision does not drag a hue collision with it.
  const GLYPHS = [
    '●',
    '■',
    '▲',
    '◆',
    '⬢',
    '★',
    '✚',
    '❋',
    '◐',
    '◑',
    '◒',
    '◓',
    '◧',
    '◨',
    '◩',
    '◪',
    '▣',
    '▤',
    '▥',
    '▦',
    '▧',
    '▨',
    '▩',
    '◈',
    '◉',
    '◍',
    '◎',
    '☀',
    '☁',
    '☂',
    '☘',
    '⚑',
  ];
  // HEX, not hsl(): the renderer's inline-style sanitizer filters hsl() values, so a mark styled
  // with them arrives colourless — the badge would be consistent in glyph but not in colour, which
  // is half of what makes an unnamed party recognisable. Found by the composition suite.
  const PALETTE = [
    '#8b5cf6',
    '#6366f1',
    '#3b82f6',
    '#0ea5e9',
    '#06b6d4',
    '#14b8a6',
    '#10b981',
    '#22c55e',
    '#84cc16',
    '#eab308',
    '#f59e0b',
    '#f97316',
    '#ef4444',
    '#f43f5e',
    '#ec4899',
    '#d946ef',
    '#a855f7',
    '#7c3aed',
    '#4f46e5',
    '#2563eb',
    '#0284c7',
    '#0891b2',
    '#0d9488',
    '#059669',
    '#16a34a',
    '#65a30d',
    '#ca8a04',
    '#d97706',
    '#ea580c',
    '#dc2626',
    '#e11d48',
    '#db2777',
  ];
  const ci =
    (Math.imul(hash ^ 0x9e37_79b9, 0x85eb_ca6b) >>> 0) % PALETTE.length;
  return {
    glyph: GLYPHS[hash % GLYPHS.length],
    hue: ci * 11,
    color: PALETTE[ci],
  };
};
