// @ts-check

/**
 * Render a chart's state graph as data or as a Mermaid `stateDiagram-v2`
 * — for documentation, review, and the workflow UI space. Pure functions
 * over chart data; no kernel involvement.
 */

import { assertChart } from './machine.js';

const { entries, keys } = Object;
const { isArray } = Array;

/**
 * Mermaid-safe identifier for a state path.
 *
 * @param {string[]} path
 * @returns {string}
 */
const idFor = path =>
  path
    .map(segment => segment.replace(/^#/, 'r').replace(/[^A-Za-z0-9_]/g, '_'))
    .join('__');

/**
 * Flatten a chart into `{ nodes, edges }`. Node ids join the state path
 * with `/`; region boundaries keep their `#<i>` segments. Each node
 * carries its kind (`state` | `compound` | `parallel` | `final`), its
 * parent id, and a short summary of its entry effects. Edges carry the
 * event type, candidate index, and whether the transition is guarded.
 *
 * @param {any} chart
 * @returns {{ nodes: any[], edges: any[] }}
 */
export const renderGraph = chart => {
  assertChart(chart);
  /** @type {any[]} */
  const nodes = [];
  /** @type {any[]} */
  const edges = [];

  const effectSummary = effect => {
    if (effect.kind === 'ask') {
      return `ask ${typeof effect.to === 'string' ? effect.to : '(templated)'}`;
    }
    if (effect.kind === 'invoke') {
      return `invoke ${typeof effect.target === 'string' ? effect.target : '(templated)'}.${effect.method}`;
    }
    if (effect.kind === 'after') {
      return effect.ms !== undefined
        ? `after ${effect.ms}ms`
        : `after ${effect.at}`;
    }
    if (effect.kind === 'spawn') {
      return `spawn ${typeof effect.chart === 'string' ? effect.chart : (effect.chart.name ?? 'chart')}`;
    }
    return `emit ${effect.event.type}`;
  };

  const walk = (states, initial, parentPath, parentId) => {
    for (const [name, def] of entries(states)) {
      const path = [...parentPath, name];
      const id = path.join('/');
      const kind =
        def.final === true
          ? 'final'
          : def.states !== undefined
            ? 'compound'
            : def.regions !== undefined
              ? 'parallel'
              : 'state';
      nodes.push(
        harden({
          id,
          name,
          kind,
          ...(parentId !== undefined ? { parent: parentId } : {}),
          ...(name === initial ? { initial: true } : {}),
          effects: harden((def.entry ?? []).map(effectSummary)),
        }),
      );
      for (const [type, candidates] of entries(def.on ?? {})) {
        candidates.forEach((t, index) => {
          edges.push(
            harden({
              from: id,
              to:
                t.target === undefined
                  ? id
                  : [...parentPath, t.target].join('/'),
              type,
              index,
              guarded: t.when !== undefined,
              internal: t.target === undefined,
            }),
          );
        });
      }
      if (def.states !== undefined) {
        walk(def.states, def.initial, path, id);
      } else if (def.regions !== undefined) {
        if (isArray(def.regions)) {
          def.regions.forEach((regionChart, i) =>
            walk(
              regionChart.states,
              regionChart.initial,
              [...path, `#${i}`],
              id,
            ),
          );
        } else {
          walk(
            def.regions.chart.states,
            def.regions.chart.initial,
            [...path, '#each'],
            id,
          );
        }
      }
    }
  };
  walk(chart.states, chart.initial, [], undefined);
  return harden({ nodes: harden(nodes), edges: harden(edges) });
};
harden(renderGraph);

/**
 * Render a chart as a Mermaid `stateDiagram-v2` document. Compound
 * states nest; parallel regions separate with `--`; a data-driven
 * `$eachParam` region renders once with a comment noting the expansion.
 *
 * @param {any} chart
 * @returns {string}
 */
export const renderMermaid = chart => {
  assertChart(chart);
  /** @type {string[]} */
  const lines = ['stateDiagram-v2'];

  /**
   * @param {Record<string, any>} states
   * @param {string} initial
   * @param {string[]} parentPath
   * @param {number} indent
   */
  const walkBody = (states, initial, parentPath, indent) => {
    const pad = '  '.repeat(indent);
    lines.push(`${pad}[*] --> ${idFor([...parentPath, initial])}`);
    for (const [name, def] of entries(states)) {
      const path = [...parentPath, name];
      const id = idFor(path);
      if (id !== name) {
        lines.push(`${pad}state "${name}" as ${id}`);
      }
      if (def.states !== undefined) {
        lines.push(`${pad}state ${id} {`);
        walkBody(def.states, def.initial, path, indent + 1);
        lines.push(`${pad}}`);
      } else if (def.regions !== undefined) {
        lines.push(`${pad}state ${id} {`);
        if (isArray(def.regions)) {
          def.regions.forEach(
            /**
             * @param {any} regionChart
             * @param {number} i
             */
            (regionChart, i) => {
              if (i > 0) {
                lines.push(`${'  '.repeat(indent + 1)}--`);
              }
              walkBody(
                regionChart.states,
                regionChart.initial,
                [...path, `#${i}`],
                indent + 1,
              );
            },
          );
        } else {
          lines.push(
            `${'  '.repeat(indent + 1)}%% one region per params.${def.regions.$eachParam}`,
          );
          walkBody(
            def.regions.chart.states,
            def.regions.chart.initial,
            [...path, '#each'],
            indent + 1,
          );
        }
        lines.push(`${pad}}`);
      }
      if (def.final === true) {
        lines.push(`${pad}${id} --> [*]`);
      }
      for (const [type, candidates] of entries(def.on ?? {})) {
        candidates.forEach(t => {
          const label = t.when === undefined ? type : `${type} [guarded]`;
          if (t.target !== undefined) {
            lines.push(
              `${pad}${id} --> ${idFor([...parentPath, t.target])} : ${label}`,
            );
          } else {
            lines.push(`${pad}${id} --> ${id} : ${label} (internal)`);
          }
        });
      }
    }
  };
  walkBody(chart.states, chart.initial, [], 1);
  return lines.join('\n');
};
harden(renderMermaid);

/**
 * The union of event types a chart can receive from outside the engine
 * (transition triggers minus the engine's own internal types), useful
 * for UI affordances.
 *
 * @param {any} chart
 * @returns {string[]}
 */
export const externalEventTypes = chart => {
  assertChart(chart);
  /** @type {Set<string>} */
  const types = new Set();
  const walk = states => {
    for (const def of Object.values(states)) {
      for (const type of keys(def.on ?? {})) {
        types.add(type);
      }
      if (def.states !== undefined) {
        walk(def.states);
      } else if (def.regions !== undefined) {
        if (isArray(def.regions)) {
          def.regions.forEach(regionChart => walk(regionChart.states));
        } else {
          walk(def.regions.chart.states);
        }
      }
    }
  };
  walk(chart.states);
  types.delete('regions-settled');
  types.delete('state-done');
  return harden([...types].sort());
};
harden(externalEventTypes);
