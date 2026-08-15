/**
 * Derive the user's visible pattern from their secret. Pure + stable: the same secret always yields
 * the same badge, which is the entire basis for recognition.
 *
 * @param {string} secret The user's unobserved pattern secret.
 * @returns {{glyph: string, words: string[], hue: number, hue2: number, phrase: string}}
 */
export function derivePattern(secret: string): {
  glyph: string;
  words: string[];
  hue: number;
  hue2: number;
  phrase: string;
};
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
export function sealPatternBadge(
  secret: string,
  opts?: {
    label?: string;
  },
): Function;
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
  storage: {
    getItem: Function;
    setItem: Function;
  },
  randomHex: () => string,
  key?: string,
): string;
