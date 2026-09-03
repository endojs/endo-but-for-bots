// @ts-check

/** @import { VNode } from 'preact' */
/** @import { RetentionPath, RetentionPathSegment, RetentionPathDelta } from '@endo/daemon' */

import harden from '@endo/harden';

import { h } from 'preact';

// Presentational rendering and the pure delta engine for the retention-paths
// panel (design `daemon-retention-paths.md` § Chat UI, Phase 4 read-only).
//
// This module holds NO host authority: it renders a `RetentionPath[]` snapshot
// into a confined Preact tree and folds `{ added, removed }` deltas into an
// ordered path set. The trusted host wrapper that owns the floating frame, the
// `followRetentionPaths` subscription, and the far-reference release lives in
// `retention-paths-panel.js`. Keeping the view and the delta engine pure makes
// them render-testable against fixtures without a daemon.
//
// NOTATION (mirrors the `endo paths` CLI, design § CLI and § Chat UI). A
// `RetentionPath` is an array of segments ordered LEAF-FIRST (index 0 is the
// target value, the last segment is a GC root). Each non-root segment carries
// the edge labels INTO it from its upstream `referencedBy` group. We render
// each path ROOT-FIRST (reversed) so the eye reads top-down from a root to the
// highlighted leaf, with the connecting edge drawn between consecutive
// segments:
//   - a `pet:<name>` edge renders as a chip with the bold pet name plus the
//     upstream store's type label,
//   - a field edge (`worker`, `petStore`, `hub`, …) renders as a small grey
//     `→<field>` arrow,
//   - a cross-peer `retention` edge and a `transient` pin render as small tags.

/**
 * Mirror of the daemon accumulator's `pathKey` (`retention-path-accumulator.js`).
 * Produces a stable structural key for a path so the UI can fold the daemon's
 * `{ added, removed }` deltas into its live ordered set by the same identity the
 * daemon diffed on. Replicated rather than imported so the UI stays independent
 * of daemon internals (the function is not part of the public `@endo/daemon`
 * surface).
 *
 * @param {RetentionPath} path
 * @returns {string}
 */
export const pathKey = path => {
  /** @type {string[]} */
  const parts = [];
  for (const seg of path) {
    parts.push(seg.referencedBy ?? '');
    parts.push((seg.labels ?? []).join('\0'));
    parts.push((seg.groupMembers ?? []).join('\0'));
    parts.push(seg.type ?? '');
  }
  return parts.join('\0\0');
};
harden(pathKey);

/**
 * Fold one `RetentionPathDelta` into an ordered `Map<pathKey, RetentionPath>`.
 * The first delta of a subscription is a `{ snapshot }` (replaces the whole
 * set); subsequent deltas are `{ added, removed }` diffs. Returns a NEW map so
 * a Preact consumer can treat the previous map as immutable. Insertion order is
 * preserved for added paths so the list does not reshuffle on every delta.
 *
 * @param {Map<string, RetentionPath>} previous
 * @param {RetentionPathDelta} delta
 * @returns {Map<string, RetentionPath>}
 */
export const applyRetentionDelta = (previous, delta) => {
  if (delta.snapshot !== undefined) {
    /** @type {Map<string, RetentionPath>} */
    const next = new Map();
    for (const path of delta.snapshot) {
      next.set(pathKey(path), path);
    }
    return next;
  }
  const next = new Map(previous);
  for (const path of delta.removed ?? []) {
    next.delete(pathKey(path));
  }
  for (const path of delta.added ?? []) {
    next.set(pathKey(path), path);
  }
  return next;
};
harden(applyRetentionDelta);

/**
 * @typedef {object} EdgeLabel
 * @property {'pet' | 'field' | 'retention' | 'transient'} kind
 * @property {string} text - Pet name (for `pet`), field name (for `field`), or
 *   the raw label.
 */

/**
 * Classify one raw edge label into its rendered kind. `pet:<name>` is the
 * human-facing pet-store edge (the central distinction of the design); the
 * `pet:` prefix is unambiguous because pet names never begin with `:`.
 * `retention` is a cross-peer edge, `transient` an in-flight host pin, and
 * everything else is a static formula field.
 *
 * @param {string} label
 * @returns {EdgeLabel}
 */
export const classifyLabel = label => {
  if (label.startsWith('pet:')) {
    return harden({ kind: 'pet', text: label.slice('pet:'.length) });
  }
  if (label === 'retention') {
    return harden({ kind: 'retention', text: label });
  }
  if (label === 'transient') {
    return harden({ kind: 'transient', text: label });
  }
  return harden({ kind: 'field', text: label });
};
harden(classifyLabel);

/**
 * A short, human-readable label for a segment's group: its first formula type
 * when the daemon resolved one (e.g. `pet-store`, `eval`, `endo`), else a
 * shortened form of the group's representative identifier.
 *
 * @param {RetentionPathSegment} segment
 * @returns {string}
 */
export const segmentTypeLabel = segment => {
  const types = segment.formulaTypes;
  if (Array.isArray(types) && types.length > 0 && types[0]) {
    return types[0];
  }
  const members = segment.groupMembers ?? [];
  if (members.length > 0) {
    const id = String(members[0]);
    // Formula identifiers are long; show a recognizable prefix.
    return id.length > 12 ? `${id.slice(0, 12)}…` : id;
  }
  return 'value';
};
harden(segmentTypeLabel);

/**
 * Render the edge labels between two segments. A pet edge becomes a chip with
 * the bold pet name plus the upstream store's type label; field edges become
 * grey `→<field>` arrows; cross-peer `retention` and `transient` pins become
 * small tags. Multiple labels on one edge render in sequence.
 *
 * @param {object} props
 * @param {string[]} props.labels - Raw edge labels.
 * @param {string} props.parentLabel - Type label of the upstream (store) group.
 * @returns {VNode}
 */
const PathEdge = ({ labels, parentLabel }) => {
  return h(
    'div',
    { class: 'retention-path-edge' },
    ...labels.map((raw, i) => {
      const { kind, text } = classifyLabel(raw);
      if (kind === 'pet') {
        return h(
          'span',
          {
            key: `${raw}-${i}`,
            class: 'retention-path-petchip',
            title: `Pet name "${text}" in ${parentLabel}`,
          },
          h('b', { class: 'retention-path-petname' }, text),
          h('span', { class: 'retention-path-petstore' }, parentLabel),
        );
      }
      if (kind === 'retention' || kind === 'transient') {
        return h(
          'span',
          {
            key: `${raw}-${i}`,
            class: `retention-path-tag retention-path-tag-${kind}`,
            title:
              kind === 'retention'
                ? 'Held alive by a cross-peer retention edge'
                : 'Held by a short-lived in-flight host operation',
          },
          text,
        );
      }
      return h(
        'span',
        {
          key: `${raw}-${i}`,
          class: 'retention-path-fieldedge',
          title: `Internal field link: ${text}`,
        },
        `→${text}`,
      );
    }),
  );
};
harden(PathEdge);

/**
 * Render one retention path root-first: the root segment, then for each
 * downstream segment the connecting edge followed by the segment chip, ending
 * with the highlighted leaf (the target value).
 *
 * @param {object} props
 * @param {RetentionPath} props.path
 * @param {number} props.index - Zero-based path index, for the heading.
 * @returns {VNode}
 */
const PathBlock = ({ path, index }) => {
  // The path array is leaf-first; render root-first for top-down reading.
  const rootToLeaf = [...path].reverse();
  const rootSegment = rootToLeaf[0];
  const rootLabel = rootSegment ? segmentTypeLabel(rootSegment) : 'value';

  /** @type {VNode[]} */
  const rows = [];
  for (let i = 0; i < rootToLeaf.length; i += 1) {
    const segment = rootToLeaf[i];
    const isRoot = i === 0;
    const isLeaf = i === rootToLeaf.length - 1;
    if (!isRoot) {
      // This segment's `labels` are the edge from the upstream (previous) group.
      const parentLabel = segmentTypeLabel(rootToLeaf[i - 1]);
      rows.push(
        h(PathEdge, {
          key: `edge-${i}`,
          labels: segment.labels ?? [],
          parentLabel,
        }),
      );
    }
    const classes = ['retention-path-segment'];
    if (isRoot) classes.push('retention-path-segment-root');
    if (isLeaf) classes.push('retention-path-segment-leaf');
    rows.push(
      h(
        'div',
        { key: `seg-${i}`, class: classes.join(' ') },
        h(
          'span',
          { class: 'retention-path-segment-type' },
          segmentTypeLabel(segment),
        ),
        isRoot
          ? h('span', { class: 'retention-path-rootbadge' }, 'root')
          : null,
        isLeaf
          ? h('span', { class: 'retention-path-leafbadge' }, 'target')
          : null,
      ),
    );
  }

  return h(
    'div',
    { class: 'retention-path-block' },
    h(
      'div',
      { class: 'retention-path-heading' },
      `Path ${index + 1} (rooted at ${rootLabel})`,
    ),
    h('div', { class: 'retention-path-chain' }, ...rows),
  );
};
harden(PathBlock);

/**
 * The small chain-link "paths" reveal affordance rendered next to a value chip
 * in the inbox, inventory, transcript, and value modal. Clicking it asks the
 * trusted controller to open the Paths panel for the chip's value; the button
 * itself holds no authority (it only invokes the passed `onReveal`).
 *
 * @param {object} props
 * @param {() => void} props.onReveal
 * @param {string} [props.title]
 * @returns {VNode}
 */
export const PathsRevealButton = ({
  onReveal,
  title = 'Show retention paths',
}) => {
  return h(
    'button',
    {
      class: 'retention-paths-reveal',
      type: 'button',
      title,
      'aria-label': title,
      /** @param {{ stopPropagation: () => void }} event */
      onClick: event => {
        event.stopPropagation();
        onReveal();
      },
    },
    // U+1F517 LINK SYMBOL — the chain-link "paths" glyph.
    '🔗',
  );
};
harden(PathsRevealButton);

/**
 * The confined presentational body of the Paths panel. Renders one of:
 * a loading state, an error state, the empty/unretained state, or the list of
 * retention paths. Holds no authority: the host wrapper drives `state` and
 * `paths` and owns the subscription.
 *
 * @param {object} props
 * @param {'loading' | 'ready' | 'error' | 'unsupported'} props.state
 * @param {RetentionPath[]} props.paths - Current path set (already delta-folded).
 * @param {string} [props.error] - Error message, when `state === 'error'`.
 * @returns {VNode}
 */
export const RetentionPathsView = ({ state, paths, error }) => {
  if (state === 'loading') {
    return h(
      'div',
      { class: 'retention-paths-body' },
      h(
        'div',
        { class: 'retention-paths-status retention-paths-loading' },
        'Resolving retention paths…',
      ),
    );
  }
  if (state === 'unsupported') {
    return h(
      'div',
      { class: 'retention-paths-body' },
      h(
        'div',
        { class: 'retention-paths-status retention-paths-empty' },
        'This value has no locator, so its retention paths cannot be listed.',
      ),
    );
  }
  if (state === 'error') {
    return h(
      'div',
      { class: 'retention-paths-body' },
      h(
        'div',
        { class: 'retention-paths-status retention-paths-error' },
        `Could not load retention paths: ${error ?? 'unknown error'}`,
      ),
    );
  }
  if (!paths || paths.length === 0) {
    return h(
      'div',
      { class: 'retention-paths-body' },
      h(
        'div',
        { class: 'retention-paths-status retention-paths-empty' },
        'No retaining paths: this value is unretained and eligible for collection.',
      ),
    );
  }
  return h(
    'div',
    { class: 'retention-paths-body' },
    ...paths.map((path, index) =>
      h(PathBlock, { key: pathKey(path), path, index }),
    ),
  );
};
harden(RetentionPathsView);
