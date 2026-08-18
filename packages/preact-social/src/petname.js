// @ts-check

/**
 * Petnames in untrusted content — "render MY name for YOUR party".
 *
 * The flagship trusted-in-untrusted use: an agent (or any confined guest)
 * references a party inline in the content it renders, and the host renders
 * the reader's own local name for that party into the hole — so the guest
 * neither learns the name (it is resolved host-side, its output unreadable)
 * nor can forge it (the chip is a confined component, gated and
 * identity-checked, not something the guest can draw and have trusted).
 *
 * The asymmetry is the ocap shape applied to naming:
 *
 *   the guest supplies the DESIGNATOR — the party OBJECT it was handed
 *   the host supplies the MEANING    — what the reader calls that party
 *
 * Designation is BY REFERENCE (PATTERNS.md): the guest passes the party
 * object, `nameOf` resolves it, and an object the guest merely fabricated is
 * not one `nameOf` knows, so it renders as unnamed. No global id, no ambient
 * lookup keyed by a guessable string.
 */

import { confineComponent } from '@endo/preact-container/compartment';

import { partyMark } from './party-mark.js';
import { withLimitedCss } from './modifiers.js';
import { freeze } from './freeze.js';

/** @import { CompartmentEndowments, ConfinedProps } from '@endo/preact-container/compartment' */

// Style is INLINE so the surrounding untrusted content's stylesheet cannot
// restyle a known name to look unknown, or hide it. `display:inline` (not
// inline-flex/inline-block) so the chip is real text on the text baseline: it
// reflows, breaks, and bidi-isolates through the browser's normal inline
// formatting, and its vertical padding paints the pill without disturbing
// line height. `unicode-bidi:isolate` keeps a name of unknown script from
// reordering the prose around it.
const BASE_STYLE =
  'display:inline;white-space:nowrap;padding:.05em .35em;' +
  'border-radius:999px;unicode-bidi:isolate;font-size:inherit;';

/**
 * Mint the sealed petname chip.
 *
 * Confine ONCE per address book, not per render: the returned component
 * registers as a trusted-exit type and is strongly referenced. `nameOf` is
 * captured in the closure and never reachable from the guest — that is what
 * keeps the address book unreadable while its answers stay renderable.
 *
 * @param {(party: object) => (string | undefined)} nameOf Host resolver:
 *   party OBJECT → the reader's local name, or undefined if unnamed/unknown.
 * @param {{ onName?: (party: object) => void, onError?: (error: unknown) => void }} [opts]
 *   `onName`, if given, makes an unnamed chip activatable so the reader can
 *   name the party on the spot; it is called with the party OBJECT and must
 *   validate it against the host's own known parties (the guest chose which
 *   object to pass). `onError` is forwarded to `confineComponent`.
 * @returns {import('preact').FunctionComponent<{ party?: object }>} The chip.
 *   A guest places it as `h(PetName, { party })` with a party it was handed.
 */
export const makePetName = (nameOf, opts = {}) => {
  const onName = typeof opts.onName === 'function' ? opts.onName : null;

  // THE CHIP OWNS ITS HANDLER. `onName` is captured here, never accepted as a
  // prop: a component that renders an interactive control must own that
  // control's behaviour, or the guest decides what your click does inside
  // chrome that looks like the host's. (`withLimitedCss` also keeps the guest
  // from restyling the chip; a party object is not a primitive, so
  // `withPrimitiveParams` deliberately does NOT apply here.)
  //
  // The cast restates the guest-facing prop contract at the boundary: the
  // `any`-typed modifiers erase `confineComponent`'s prop generic, so we name
  // it here rather than let the wrapper widen to `FunctionComponent<{}>`.
  const render =
    /** @type {(e: CompartmentEndowments, p: ConfinedProps<{ party?: object }>) => import('preact').VNode} */ (
      withLimitedCss(({ h }, { party }) => {
        const isParty =
          party !== null &&
          (typeof party === 'object' || typeof party === 'function');
        let name;
        try {
          name =
            isParty && typeof nameOf === 'function' ? nameOf(party) : undefined;
        } catch (_) {
          // A throwing resolver must not become a rendering hole.
          name = undefined;
        }
        const known = typeof name === 'string' && name.length > 0;
        // A known party gets its stable mark; we do NOT mint a mark for an
        // unknown/fabricated object, so the guest cannot grow the mark table by
        // passing throwaway objects. `known` implies `nameOf` resolved `party`,
        // which only happens for an object, so the cast is sound.
        const mark = known ? partyMark(/** @type {object} */ (party)) : null;
        const nameable = !known && isParty && onName;

        const style =
          BASE_STYLE +
          (known
            ? 'font-weight:600;background-color:color-mix(in srgb, currentColor 12%, transparent);'
            : 'opacity:.75;font-style:italic;') +
          (nameable ? 'cursor:pointer;' : '') +
          (mark ? `color:${mark.color};` : '');

        const attrs = {
          class: known ? 'petname' : 'petname petname-unknown',
          style,
        };
        if (nameable) {
          attrs.role = 'button';
          attrs.tabindex = 0;
          attrs.title = 'Give this party a local name';
          attrs.onClick = () => onName(party);
          attrs.onKeyDown = e => {
            if (e && (e.key === 'Enter' || e.key === ' ')) onName(party);
          };
        }

        return h(
          'span',
          attrs,
          mark
            ? h(
                'span',
                { 'aria-hidden': 'true', style: 'margin-inline-end:.25em' },
                mark.glyph,
              )
            : null,
          // Unknown renders as a fixed word, NEVER the raw designator and never
          // guest-supplied text — the fallback is the attack surface here.
          h(
            'span',
            null,
            known ? String(name) : nameable ? 'name this…' : 'unnamed',
          ),
        );
      })
    );
  return confineComponent(render, { name: 'PetName', onError: opts.onError });
};
freeze(makePetName);
