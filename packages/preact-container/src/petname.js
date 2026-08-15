// @ts-check

/**
 * Petnames in untrusted content (designs/trusted-in-untrusted-secure-ui.md Inc 4).
 *
 * The vault's leading example of trusted-in-untrusted, and the first NON-security use of the seal:
 * render the operator's own local name for a remote identifier inside model-authored content, so the
 * agent — and anything the agent is quoting — can neither READ the address book nor SPOOK a name.
 *
 * The asymmetry is the whole point, and it is the ocap shape applied to naming:
 *
 *   the untrusted side supplies the DESIGNATOR (an id it already has)
 *   the trusted side supplies the MEANING (what the operator calls that party)
 *
 * An agent writing "message ▧ Alice about this" has not learned that you call them Alice; it emitted
 * an id and the host rendered your name into the hole. And it cannot write "▧ Alice" itself in a way
 * that survives — it can draw the characters, but not the sealed chip, which is what the operator
 * learns to read (pairs with the composition frame's party marks and persons-and-shares).
 *
 * UNKNOWN IDS RENDER AS UNKNOWN. Not as the raw identifier (which teaches the operator to read
 * identifiers as names, defeating the point) and never as text the untrusted side supplied — the
 * fallback is the attack surface here, because an attacker's easiest move is to reference an id you
 * have no name for and hope the fallback shows something it chose.
 */

import { h } from 'preact';
import { sealComponent } from './compartment.js';
import { handleFor, partyForHandle, markFor } from './party-identity.js';

/**
 * Short, non-name rendering for an id the operator has never named. Deliberately looks like an
 * identifier fragment rather than a word, so it cannot be mistaken for a petname.
 *
 * @param {string} id
 */
const unknownLabel = tag => {
  const s = String(tag || '');
  return s ? `unnamed ⋯${s}` : 'unnamed';
};

/** A SHORT, non-identifying tag for an unnamed party: enough to tell two apart in prose, and derived
 *  from the stable seed rather than from any real identifier — we never render the designator. */
const partyIdentitySeedless = party => markFor(party).color.slice(1, 5);

/**
 * Mint the sealed petname chip.
 *
 * Seal ONCE per lookup, not per render: the placeholder registers as a trusted exit, which holds a
 * strong reference. The lookup is captured here and is never reachable from the untrusted side —
 * that is what keeps the address book unreadable while its ANSWERS stay renderable.
 *
 * @param {(id: string) => (string | undefined)} lookup Host-side resolver: id → the operator's local
 *   name, or undefined if they have not named that party.
 * @param {{ marker?: string }} [opts] `marker`: glyph shown before the name.
 * @returns {Function} A sealed component. Untrusted callers may pass only `id`.
 */
export const sealPetName = (nameOf, opts = {}) => {
  const marker = String(opts.marker == null ? '▧' : opts.marker);
  // THE SEAL OWNS THE HANDLER. An unnamed party is clickable so the operator can name it on the
  // spot — and `onName` is captured HERE, never accepted as a param. A sealed component that renders
  // an interactive control must own that control's behaviour: a handler arriving from the untrusted
  // side would let it decide what your click does, inside chrome that looks like ours. (The
  // primitives-only param rule already forbids passing a function in; this is the positive form of
  // the same rule.) The callback receives the PARTY OBJECT, not a name or an id.
  const onName = typeof opts.onName === 'function' ? opts.onName : null;
  const PetName = sealComponent(
    ({ partyRef }) => {
      // NOT named `ref` — that name is unconditionally dropped by the coercer, so it would silently
      // never arrive. `partyRef` is an opaque HANDLE minted by party-identity for a party object the host chose to
      // designate — NOT an id. A handle the untrusted side invented resolves to nothing, so it can
      // only name parties it was actually given.
      const party = partyForHandle(partyRef);
      let name;
      try {
        name = party && typeof nameOf === 'function' ? nameOf(party) : undefined;
      } catch {
        name = undefined; // a throwing resolver must not become a rendering hole
      }
      const known = typeof name === 'string' && name.length > 0;
      // An UNNAMED party is still consistently badged and coloured, from its stable seed — the mark
      // tracks WHO, the name tracks what you call them, so naming later never changes the mark.
      const mk = party ? markFor(party) : null;
      const nameable = !known && party && onName;
      return h(
        'span',
        {
          class: known ? 'petname' : 'petname petname-unknown',
          // Only the UNNAMED chip is interactive, and only when the host gave us somewhere to go.
          ...(nameable
            ? {
                role: 'button',
                tabindex: 0,
                title: 'Give this party a local name',
                onClick: () => onName(party),
                onKeyDown: e => { if (e && (e.key === 'Enter' || e.key === ' ')) onName(party); },
              }
            : {}),
          // Inline style for the same reason the pattern badge uses one: an untrusted stylesheet
          // around this content must not be able to restyle a known name to look unknown, or an
          // unknown one to look like a name you trust.
          // display:INLINE, not inline-flex. An inline-flex box with align-items:center has NO flex
          // item on the baseline, so per CSS Flexbox it SYNTHESIZES its baseline from the bottom of
          // its border box — the chip sits visibly low and inflates the line box by the descender.
          // It is also atomic: it can never break and contributes its full margin-box height to
          // line-height. Both symptoms, one root cause. `inline-block` is not the fix either (same
          // synthesized-baseline hazard, still unbreakable, and its vertical padding DOES push lines
          // apart). `display:inline` simply IS text on the text baseline — the browser's inline
          // formatting context handles reflow, breaking and bidi for free, which is why we should
          // never have opted out of it. Vertical padding on an inline box paints without affecting
          // line-height, which gives the pill look at no layout cost.
          //
          // INSIDE the inline style: a plain inline declaration LOSES to an author rule
          // marked, so untrusted CSS reaching this subtree could flatten a known name
          // toward the unknown presentation. Inline wins outright. (Belt for the
          // renderer's attribute filtering, not a replacement for it.)
          style:
            'display:inline;white-space:nowrap;padding:.05em .35em;border-radius:999px;'
            + 'unicode-bidi:isolate;' // a name of unknown script must not reorder the prose around it
            + 'font-size:inherit;'
            + (nameable ? 'cursor:pointer;' : '')
            + (known
              ? 'font-weight:600;background-color:color-mix(in srgb, currentColor 12%, transparent);font-style:normal;'
              : mk
                // consistently badged AND coloured, per party, even with no name yet
                ? `font-weight:600;color:${mk.color};font-style:normal;`
                : 'opacity:.75;font-weight:400;font-style:italic;background-color:transparent;'),
          // No `title` carrying the raw id: a tooltip is still disclosure, and the operator did not
          // ask to see identifiers.
        },
        // `gap` is meaningless on an inline box; horizontal margin works on one. (NBSP would also
        // work but its width is font-dependent.)
        mk || known ? h('span', { 'aria-hidden': 'true', style: 'margin-inline-end:.25em' }, mk ? mk.glyph : marker) : null,
        h('span', null, known ? String(name) : (nameable ? 'name this ⋯' : unknownLabel(party ? partyIdentitySeedless(party) : ''))),
      );
    },
    { params: ['partyRef'] },
  );
  // The mint travels WITH the component: a caller that can place a chip is a caller that can
  // designate a party, and neither is reachable from the untrusted side.
  return { PetName, handleFor };
};
