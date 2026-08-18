// @ts-check

/**
 * Multi-party inline composition — several parties' content in one document,
 * each region attributed to its source, and no party able to read another's
 * input or output.
 *
 * On this package's model the composition layer is almost nothing, because the
 * hard parts belong to primitives underneath it:
 *
 *   · SIBLING OPACITY is a property of `confineComponent`, not of this module.
 *     Each region's content is a separate confined component; a confined
 *     component receives only its own props and can reach neither a sibling's
 *     props/output nor the frame's DOM. This module does not enforce that — it
 *     relies on it, and the tests pin it as the attack it is.
 *
 *   · THE FRAME PLACES THE ATTRIBUTION; A PARTY NEVER TOUCHES IT
 *     (PATTERNS.md §3). `composeRegions` is trusted HOST code, so it draws each
 *     mark itself from the party's public `partyMark` and the reader's local
 *     name, baked into the trusted tree as text a sibling party cannot reach.
 *     A party is designated by OBJECT; it is never handed the machinery that
 *     would let it claim another's name. (This is why the original design's
 *     sealed `Attribution` component and its resolver-token plumbing are gone:
 *     a benign mark drawn by trusted host code needs no seal.)
 *
 *   · An optional frame badge (a pattern badge, minted once by the caller)
 *     authenticates the composition itself: "assembled by the real system;
 *     these attributions are its claims, not the content's."
 *
 * Two rules the design turns on, both about NOT letting content borrow
 * authority:
 *   - an unattributed region renders as unattributed — it never inherits the
 *     enclosing frame's or a neighbour's mark;
 *   - region content that is not a confined component is visibly REFUSED, never
 *     rendered — a raw function would run with host authority under someone
 *     else's mark.
 */

import { h } from 'preact';
import { isConfinedComponent } from '@endo/preact-container/compartment';

import { partyMark } from './party-mark.js';
import { freeze } from './freeze.js';

const MARK_BASE =
  'display:inline;white-space:nowrap;padding:.05em .4em;border-radius:999px;' +
  'unicode-bidi:isolate;font-size:11px;font-weight:600;';

// The attribution mark, drawn by the frame. Never handed to a party.
const renderAttribution = (party, nameOf) => {
  const isParty =
    party !== null &&
    (typeof party === 'object' || typeof party === 'function');
  if (!isParty) {
    // Unattributed renders AS unattributed — never inheriting a neighbour's or
    // the frame's mark (the composition-level vanishing-badge problem).
    return h(
      'span',
      {
        class: 'party-mark party-mark-none',
        style: `${MARK_BASE}border:1px dashed currentColor;opacity:.7;`,
      },
      '(unattributed)',
    );
  }
  const mark = partyMark(party);
  let name;
  try {
    name = typeof nameOf === 'function' ? nameOf(party) : undefined;
  } catch (_) {
    name = undefined; // a throwing resolver must not become a rendering hole
  }
  const known = typeof name === 'string' && name.length > 0;
  return h(
    'span',
    {
      class: known ? 'party-mark' : 'party-mark party-mark-unnamed',
      style: `${MARK_BASE}color:${mark.color};border:1px solid ${mark.color};`,
    },
    h(
      'span',
      { 'aria-hidden': 'true', style: 'margin-inline-end:.25em' },
      mark.glyph,
    ),
    // Unnamed is still MARKED and COLOURED; only the label is missing, and it
    // says so plainly rather than falling back to any identifier.
    h('span', null, known ? String(name) : 'unnamed'),
  );
};

// A region's content must be a confined component; anything else is refused
// visibly rather than rendered with host authority under a party's mark.
const renderContent = region => {
  const Component = region && region.Component;
  if (!Component) return null;
  if (!isConfinedComponent(Component)) {
    return h(
      'span',
      {
        class: 'party-content-refused',
        style: 'opacity:.7;font-style:italic;',
      },
      '(content refused: not a confined component)',
    );
  }
  return h(Component, (region && region.props) || {});
};

/**
 * Build a multi-party composition tree. Render the result through
 * `renderConfined`.
 *
 * @param {Array<{ party?: object, Component: import('preact').FunctionComponent<any>, props?: object }>} regions
 *   Each region's `party` is the party OBJECT (not a name/id); `Component` is a
 *   `confineComponent` wrapper for that party's content; `props` is that
 *   party's own input, passed to nobody else.
 * @param {{ nameOf?: (party: object) => (string | undefined), FrameBadge?: import('preact').FunctionComponent<any>, label?: string }} [opts]
 *   `nameOf`: host resolver, party OBJECT → the reader's local name (host-side,
 *   never handed to a region). `FrameBadge`: an OPTIONAL pattern badge minted
 *   ONCE by the caller (`makePatternBadge`) — placed in the frame header to
 *   authenticate the composition. `label`: optional frame label text.
 * @returns {import('preact').VNode}
 */
export const composeRegions = (regions, opts = {}) => {
  const list = Array.isArray(regions) ? regions : [];
  const { nameOf, FrameBadge, label } = opts;
  return h(
    'div',
    { class: 'composition' },
    // The frame's own claim, once, at the top.
    FrameBadge || label
      ? h(
          'div',
          { class: 'composition-frame' },
          FrameBadge ? h(FrameBadge, {}) : null,
          label ? h('span', null, String(label)) : null,
        )
      : null,
    ...list.map((region, i) =>
      h(
        'section',
        { class: 'party-region', key: `region-${i}` },
        // The frame places the mark, from the party it composed — never from a
        // value a region's own code supplied, and never by handing a region
        // this component.
        renderAttribution(region && region.party, nameOf),
        h('div', { class: 'party-content' }, renderContent(region)),
      ),
    ),
  );
};
freeze(composeRegions);
