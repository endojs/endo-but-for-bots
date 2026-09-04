// @ts-check

import { freeze } from './freeze.js';

/**
 * A stable visual mark for a party, designated BY OBJECT.
 *
 * The one rule this module exists to enforce (see PATTERNS.md § "Designate by
 * reference"): a party is named by passing THE PARTY OBJECT, never a string id.
 * An id is global and forgeable and needs an ambient lookup to resolve; an
 * object reference is held or not held, and its identity is the lookup key.
 * `partyMark` therefore keys off the object itself (a `WeakMap`), so:
 *
 *   - the same object always yields the same mark (recognition), and
 *   - a party with no local name yet still has a consistent mark, because the
 *     mark tracks WHO (the object), not what you call them (the name).
 *
 * The mark is PUBLIC: it distinguishes parties, it does not authenticate
 * anything. Do not confuse it with the security pattern in `pattern-badge.js`,
 * which is a secret. Conflating the two inverts the property — a public mark
 * anyone can derive becomes an impersonation surface. Keep them apart.
 */

// High-contrast glyphs and colours, chosen so two parties are told apart at a
// glance. Colours are plain hex strings — a simple, self-contained value with
// no dependency on how any CSS-function syntax is treated downstream.
const GLYPHS = freeze([
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
  '◧',
  '◨',
  '▣',
  '▤',
  '▥',
  '▦',
  '▧',
  '▨',
  '◈',
  '◉',
  '◍',
  '◎',
  '☀',
  '☁',
  '☘',
  '⚑',
  '✦',
  '✧',
  '❖',
  '◇',
  '□',
  '△',
]);

const PALETTE = freeze([
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
]);

// party object → its assigned mark. WeakMap so a party is collectable once no
// one holds it; the mark is not persisted (it is per-session, like the address
// book's in-memory identities).
const marks = new WeakMap();

// Marks are assigned in first-seen order rather than hashed from a random
// seed. This is deliberate: the mark is public and non-secret, so it needs no
// unguessable seed, and a deterministic assignment removes the flaky
// "two random seeds collided" failures that a hash-of-random approach invites.
// `GLYPHS.length` is coprime with the colour stride, so the first
// `GLYPHS.length` parties get distinct glyph *and* colour; after that the pair
// repeats. Extend the tables if you need to distinguish more parties on screen
// at once than that.
let nextIndex = 0;
const COLOR_STRIDE = 7; // coprime with 32 ⇒ cycles the whole palette

/**
 * The stable mark for a party.
 *
 * @param {object} party The party OBJECT — not a name, not an id.
 * @returns {{ glyph: string, color: string }}
 */
export const partyMark = party => {
  if (
    party === null ||
    (typeof party !== 'object' && typeof party !== 'function')
  ) {
    // A string here is exactly the mistake this module prevents: fail loudly
    // rather than mint a mark for a forgeable designator.
    throw new TypeError(
      'partyMark: designate a party by object, not by id (see PATTERNS.md)',
    );
  }
  let mark = marks.get(party);
  if (mark === undefined) {
    const i = nextIndex;
    nextIndex += 1;
    mark = freeze({
      glyph: GLYPHS[i % GLYPHS.length],
      color: PALETTE[(i * COLOR_STRIDE) % PALETTE.length],
    });
    marks.set(party, mark);
  }
  return mark;
};
freeze(partyMark);
