// @ts-check

/**
 * Multi-party inline composition (designs/trusted-in-untrusted-secure-ui.md Inc 5).
 *
 * Renders several parties' content in one document — a friend's commentary threaded through someone
 * else's text — where no party can read another's input and every region is attributable to its source.
 *
 * The whole design rests on one rule, learned the hard way in `test/sibling-opacity.test.js`:
 *
 *   THE FRAME PLACES THE ATTRIBUTION. A PARTY NEVER TOUCHES IT.
 *
 * A confined party can always DRAW a lookalike mark — pixels are not authenticated — and if it were
 * ever handed the sealed `Attribution` component it could place it claiming to be someone else, since
 * `party` crosses as a declared primitive param. So parties are never given a reference to it. The
 * frame builds the whole tree itself and hands each party only its own props.
 *
 * Two marks with two different jobs, and conflating them inverts the security property:
 *
 *   · the FRAME badge is the operator's SECRET pattern — it authenticates the composition itself
 *     ("this was assembled by the real system, and these attributions are its claims"). Unguessable,
 *     which is the entire mechanism: an attacker who cannot see it cannot match it.
 *   · a PARTY mark is derived from a PUBLIC identity. It distinguishes sources; it proves nothing on
 *     its own. It is trustworthy only because the frame drew it, inside a frame the secret pattern
 *     authenticated. Minted like the secret it would become an impersonation surface instead.
 *
 * Sibling opacity itself is not enforced here — it is a property of `confineComponent` plus SES
 * lockdown (without `harden` two parties share a mutable channel; see the note in compartment.js).
 * This module is the composition layer on top of that boundary, not a second boundary.
 */

import { h } from 'preact';
import { sealComponent, isConfinedComponent } from './compartment.js';
import { handleFor, partyForHandle, markFor } from './party-identity.js';
import { sealPatternBadge } from './security-pattern.js';

/**
 * Public, deterministic mark for a party name. Distinct GLYPH SET from `derivePattern`'s, on purpose:
 * a party mark must not be mistakable for the operator's secret pattern, or the weaker signal borrows
 * the stronger one's authority.
 *
 * @param {string} party
 * @returns {{ glyph: string, hue: number }}
 */
// Marks derive from the party OBJECT's stable seed (party-identity.js), not from its name — so
// naming or renaming a party never changes its mark, and an unnamed party is still consistently
// badged. Re-exported for callers that need the mark without rendering a chip.
export { markFor as derivePartyMark } from './party-identity.js';

/**
 * The attribution mark, sealed ONCE for the module rather than per render — the placeholder registers
 * itself as a trusted exit, which holds a strong reference, so minting per call leaks.
 *
 * `party` is a declared primitive param, which is exactly why this component must never reach a party:
 * anyone holding it could place it claiming any name. Only this module places it.
 */
let nameOfParty = () => undefined; // set per composeRegions call; the resolver is host-side only

const Attribution = sealComponent(
  ({ partyRef }) => {
    // NOT named `ref`: that name is in DROPPED_PROPS_ALWAYS and is stripped from every vnode, so a
    // param called `ref` silently never arrives. `partyRef` is an opaque handle for a party OBJECT the frame designated — never an id, and never a
    // name a region supplied. A handle the untrusted side invented resolves to nothing.
    const party = partyForHandle(partyRef);
    if (!party) {
      // An unattributed region renders as UNATTRIBUTED. It must never inherit the enclosing party's
      // mark — content silently borrowing authority from its container is the composition-level
      // version of the vanishing-badge problem.
      return h(
        'span',
        {
          class: 'party-mark party-mark-none',
          style:
            'display:inline;white-space:nowrap;padding:.05em .35em;border-radius:999px;' +
            'border:1px dashed currentColor;opacity:.7;font-size:11px;',
        },
        '(unattributed)',
      );
    }
    let name;
    try {
      name = nameOfParty(party);
    } catch {
      name = undefined;
    }
    const { glyph, color } = markFor(party);
    const known = typeof name === 'string' && name.length > 0;
    return h(
      'span',
      {
        class: known ? 'party-mark' : 'party-mark party-mark-unnamed',
        // display:inline so a mark reflows as text (an inline-flex chip synthesizes its baseline from
        // its border box and can never break — see petname.js). Inline because a plain
        // inline declaration LOSES to an author rule.
        style:
          'display:inline;white-space:nowrap;padding:.05em .4em;border-radius:999px;' +
          'unicode-bidi:isolate;' +
          `color:${color};` +
          `border:1px solid ${color};font-size:11px;font-weight:600;`,
      },
      h(
        'span',
        { 'aria-hidden': 'true', style: 'margin-inline-end:.25em' },
        glyph,
      ),
      // Unnamed is still MARKED and COLOURED — only the label is missing, and it says so plainly
      // rather than falling back to any identifier.
      h('span', null, known ? String(name) : 'unnamed'),
    );
  },
  { params: ['partyRef'] },
);

/** Frame badges are per-secret; cache so repeated compositions do not mint (and pin) a new seal each time. */
const frameBadges = new Map();
const frameBadgeFor = secret => {
  const key = String(secret == null ? '' : secret);
  let badge = frameBadges.get(key);
  if (!badge) {
    badge = sealPatternBadge(key, { label: '' });
    frameBadges.set(key, badge);
  }
  return badge;
};

/**
 * REFUSE UNCONFINED CONTENT. `composeRegions` runs as HOST code, so the tree it builds is trusted —
 * `renderConfined`'s coerceType gate only screens vnodes returned BY confined code, not ones the host
 * assembled. That means a raw function passed in as a region would have been rendered with full host
 * authority while wearing a party mark: the composition surface would become a way to smuggle
 * unconfined code into the page under someone else's name. Caught by the suite, which expected the
 * renderer to drop it — the renderer was right not to; the frame has to screen its own inputs.
 *
 * The region is still ATTRIBUTED and still occupies its slot, so a refusal is visible rather than a
 * silently missing region.
 *
 * @param {{ Component?: Function, props?: object }} r
 */
const renderableContent = r => {
  const C = r && r.Component;
  if (!C) return null;
  if (!isConfinedComponent(C)) {
    return h(
      'span',
      { class: 'party-content-refused', style: 'opacity:.7;font-style:italic' },
      '(content refused: not confined)',
    );
  }
  return h(C, (r && r.props) || {});
};

/**
 * Build the composition tree. Render the result through `renderConfined`.
 *
 * @param {Array<{ party?: object, Component: Function, props?: object }>} regions
 *   `party` is the party OBJECT, not a name — see designs/designation-by-object-not-id.md.
 *   Each region's `Component` should be a `confineComponent` wrapper — the renderer drops a raw
 *   function type, which is the correct outcome for unconfined content rather than a bug to work
 *   around. `props` is that party's own input and is passed to nobody else.
 * @param {{ secret?: string, label?: string }} [opts] `secret`: the operator's pattern secret.
 * @returns {import('preact').VNode}
 */
export const composeRegions = (regions, opts = {}) => {
  const list = Array.isArray(regions) ? regions : [];
  // The name resolver is HOST-SIDE and per-call. It is never handed to a region, and it is keyed on
  // the party OBJECT — there is no lookup that turns an arbitrary string into a party.
  nameOfParty =
    typeof opts.nameOf === 'function' ? opts.nameOf : () => undefined;
  const FrameBadge = frameBadgeFor(opts.secret);
  return h(
    'div',
    { class: 'composition' },
    // The frame's own claim, once, at the top: everything below is composed by the system.
    h(
      'div',
      { class: 'composition-frame' },
      h(FrameBadge, {}),
      opts.label ? h('span', null, String(opts.label)) : null,
    ),
    ...list.map((r, i) =>
      h(
        'section',
        { class: 'party-region', key: `region-${i}` },
        // The frame places the mark, parameterized by the party the FRAME composed — never by a value
        // the region's own code supplied, and never by handing the region this component.
        h(Attribution, { partyRef: r && r.party ? handleFor(r.party) : '' }),
        h('div', { class: 'party-content' }, renderableContent(r)),
      ),
    ),
  );
};
