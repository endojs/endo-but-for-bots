// @ts-check

/** @import { VNode } from 'preact' */

import harden from '@endo/harden';

import { h } from 'preact';

/**
 * One segment of a retention path: a garbage-collection group and the
 * edge by which it is reached from the segment closer to the root.
 * Mirrors the daemon's `RetentionPathSegment`
 * (`packages/daemon/src/graph.js`), sourced from #284's
 * `EndoHost.listRetentionPaths`.
 *
 * @typedef {object} RetentionPathSegment
 * @property {string[]} groupMembers
 *   The formula ids (or petnames, once resolved) that share this GC group.
 * @property {string} [referencedBy]
 *   The upstream group representative that retains this one.
 * @property {string[]} [labels]
 *   Edge labels from the upstream segment. A `pet:<name>` label is a
 *   pet-store edge; any other label is a static formula-field edge.
 * @property {'root'} [type]
 *   Present only on the root (garbage-collection root) segment.
 * @property {string[]} [formulaTypes]
 *   Per-member formula type, positionally aligned with `groupMembers`.
 */

/** @typedef {RetentionPathSegment[]} RetentionPath */

/**
 * @typedef {'loading' | 'error' | 'ready'} RetentionPathsState
 */

/**
 * Whether a segment is the garbage-collection root of its path.
 *
 * @param {RetentionPathSegment} segment
 * @returns {boolean}
 */
const isRootSegment = segment => segment.type === 'root';

/**
 * The display name of a path's root: the first group member of the root
 * segment (paths are ordered leaf-to-root, so the root is the last
 * segment). Returns `undefined` when the path does not terminate at a
 * garbage-collection root.
 *
 * @param {RetentionPath} path
 * @returns {string | undefined}
 */
const rootNameOf = path => {
  const rootSegment = path[path.length - 1];
  if (!rootSegment || !isRootSegment(rootSegment)) return undefined;
  const [first] = rootSegment.groupMembers || [];
  return first;
};

/**
 * A structural key for a retention path, stable across snapshots. Used
 * as a secondary sort key (so equal-length, equal-root paths order
 * deterministically) and as a Preact list key.
 *
 * @param {RetentionPath} path
 * @returns {string}
 */
export const retentionPathKey = path =>
  path
    .map(seg => {
      const members = (seg.groupMembers || []).join(',');
      const labels = (seg.labels || []).join(',');
      return `${members}|${labels}`;
    })
    .join('>');
harden(retentionPathKey);

/**
 * Order retention paths so the table is scannable when there are many:
 * shortest (most direct) paths first, then alphabetically by root name,
 * then by structural key for a total order. Returns a new array; the
 * input is not mutated.
 *
 * @param {RetentionPath[]} paths
 * @returns {RetentionPath[]}
 */
export const sortRetentionPaths = paths =>
  [...paths].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    const ra = rootNameOf(a) || '';
    const rb = rootNameOf(b) || '';
    if (ra !== rb) return ra < rb ? -1 : 1;
    const ka = retentionPathKey(a);
    const kb = retentionPathKey(b);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
harden(sortRetentionPaths);

/**
 * Render the edge labels that separate one segment from the next one
 * toward the leaf. A `pet:<name>` label renders as the quoted pet name;
 * any other label renders as `→<field>`; an unlabeled edge renders as a
 * bare `→`.
 *
 * @param {string[]} labels
 * @param {number} pathIndex
 * @param {number} edgeIndex
 * @returns {VNode}
 */
const renderEdge = (labels, pathIndex, edgeIndex) => {
  /** @type {VNode[]} */
  const parts = [];
  if (labels.length === 0) {
    parts.push(
      h(
        'span',
        { class: 'retention-path-edge retention-path-edge-field' },
        '→',
      ),
    );
  } else {
    labels.forEach((label, i) => {
      if (label.startsWith('pet:')) {
        parts.push(
          h(
            'span',
            {
              class: 'retention-path-edge retention-path-edge-pet',
              key: `e-${edgeIndex}-${i}`,
              title: 'pet-store name',
            },
            `"${label.slice('pet:'.length)}"`,
          ),
        );
      } else {
        parts.push(
          h(
            'span',
            {
              class: 'retention-path-edge retention-path-edge-field',
              key: `e-${edgeIndex}-${i}`,
              title: 'formula field',
            },
            `→${label}`,
          ),
        );
      }
    });
  }
  return h(
    'span',
    {
      class: 'retention-path-edge-group',
      key: `edge-${pathIndex}-${edgeIndex}`,
    },
    ...parts,
  );
};

/**
 * Render a single retention path as a flow of segment chips separated by
 * edge labels, read root-to-leaf (the daemon delivers segments
 * leaf-to-root, so this reverses them for display, matching the CLI
 * renderer in `packages/cli/src/render-retention-path.js`).
 *
 * @param {RetentionPath} path
 * @param {number} pathIndex
 * @returns {VNode}
 */
const renderPath = (path, pathIndex) => {
  const segments = [...path].reverse();
  /** @type {VNode[]} */
  const flow = [];
  segments.forEach((seg, i) => {
    const isRoot = isRootSegment(seg);
    const isTarget = i === segments.length - 1;
    const members = (seg.groupMembers || []).join(', ');
    const types = seg.formulaTypes || [];
    const typeMarker = isRoot
      ? 'root'
      : types.length > 0
        ? types.join(', ')
        : '';
    const chipClasses = [
      'retention-path-segment',
      isRoot ? 'retention-path-segment-root' : '',
      isTarget ? 'retention-path-segment-target' : '',
    ]
      .filter(Boolean)
      .join(' ');
    flow.push(
      h(
        'span',
        { class: chipClasses, key: `seg-${pathIndex}-${i}` },
        h('span', { class: 'retention-path-member' }, members || '(unnamed)'),
        typeMarker !== ''
          ? h('span', { class: 'retention-path-type' }, `(${typeMarker})`)
          : null,
      ),
    );
    // The edge separating this segment from the next one toward the leaf
    // is carried on the *next* segment's `labels` (the daemon stores each
    // segment's inbound edge from its upstream retainer).
    if (i < segments.length - 1) {
      const next = segments[i + 1];
      flow.push(renderEdge(next.labels || [], pathIndex, i));
    }
  });

  const rootName = rootNameOf(path);
  const banner = rootName
    ? `Path ${pathIndex + 1} — rooted at ${rootName}`
    : `Path ${pathIndex + 1}`;

  return h(
    'li',
    { class: 'retention-path', key: `path-${retentionPathKey(path)}` },
    h('div', { class: 'retention-path-banner' }, banner),
    h('div', { class: 'retention-path-segments' }, ...flow),
  );
};

/**
 * Render the "Retention paths" table for the formula inspector's back
 * face. Read-only: it lists every path by which the inspected formula is
 * retained (each row a path from a garbage-collection root through the
 * reference graph to this value), sourced from #284's
 * `EndoHost.listRetentionPaths` snapshot.
 *
 * States:
 * - `loading`: the snapshot is in flight.
 * - `error`: the snapshot could not be fetched (message in `error`).
 * - `ready` (the default when `paths` is an array): render the table, or
 *   the empty state when there are no retaining paths.
 *
 * The list is sorted shortest-path-first and scrolls within a bounded
 * height so a value retained by many paths stays scannable. All
 * daemon-supplied strings (member ids, pet names, field labels) render as
 * escaped Preact text children through the confined renderer.
 *
 * @param {object} props
 * @param {RetentionPath[]} [props.paths]
 * @param {RetentionPathsState} [props.state]
 * @param {string} [props.error]
 * @returns {VNode}
 */
export const RetentionPathsView = ({ paths, state, error }) => {
  const resolvedState = state || (Array.isArray(paths) ? 'ready' : 'loading');
  const count = Array.isArray(paths) ? paths.length : 0;

  const heading = h(
    'div',
    { class: 'retention-paths-heading' },
    h('span', { class: 'retention-paths-title' }, 'Retention paths'),
    resolvedState === 'ready' && count > 0
      ? h(
          'span',
          {
            class: 'retention-paths-count',
            title: `${count} retaining ${count === 1 ? 'path' : 'paths'}`,
          },
          String(count),
        )
      : null,
  );

  /** @type {VNode} */
  let body;
  if (resolvedState === 'loading') {
    body = h(
      'div',
      { class: 'formula-view-loading retention-paths-message' },
      'Loading retention paths…',
    );
  } else if (resolvedState === 'error') {
    body = h(
      'div',
      { class: 'formula-view-error retention-paths-message' },
      error || 'Could not load retention paths.',
    );
  } else if (count === 0) {
    body = h(
      'div',
      { class: 'formula-view-empty retention-paths-message' },
      'No retaining paths — this value is not reachable from any ' +
        'garbage-collection root (unretained).',
    );
  } else {
    const sorted = sortRetentionPaths(paths || []);
    body = h(
      'ul',
      { class: 'retention-paths-list' },
      ...sorted.map((path, i) => renderPath(path, i)),
    );
  }

  return h('section', { class: 'retention-paths' }, heading, body);
};
harden(RetentionPathsView);
