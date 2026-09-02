// @ts-check

/**
 * The pure workflow kernel: a hardened statechart interpreter over
 * passable chart data.
 *
 * A chart is data — states, pattern-guarded transitions, and effect
 * descriptions — and this module is its complete semantics. It performs
 * no I/O, reads no clock, and mints no capabilities: `transition` is a
 * pure synchronous function from (chart, machine state, event envelope)
 * to (machine state, effect descriptions, internal events). The service
 * layer (`./service.js`) owns journaling, effect performance, and time.
 *
 * Model:
 *
 * - A machine state is `{ configuration, context }` plus the immutable
 *   run `params`. The configuration is a tree of active states:
 *   `{ state, child?, regions? }`, where `child` is a nested compound
 *   state's configuration and `regions` is an array of parallel region
 *   nodes `{ params, context, config, done, output? }`. Regions are
 *   separate machine frames with their own params and context; compound
 *   nesting shares the enclosing frame's context.
 * - State paths name nodes in the configuration: state names joined as
 *   an array, with `'#<i>'` segments at region boundaries (state names
 *   may not begin with `#`).
 * - Events are envelopes `{ type, value?, by, at, path?, ... }`. An
 *   envelope with a `path` is routed only along that path (bubbling
 *   innermost-out along the still-active prefix), so the outcome of an
 *   effect dispatched by one region cannot fire its identical sibling
 *   regions. An envelope without a path broadcasts — regions first, then
 *   nested children, then the state itself, innermost-first, at most one
 *   transition per orthogonal region.
 * - Guards are `@endo/patterns` patterns matched against the whole
 *   envelope; the kernel enriches join envelopes with computed `counts`
 *   and `outcomes` so quorum guards stay total.
 */

import { Fail, q } from '@endo/errors';
import { matches, mustMatch, assertPattern } from '@endo/patterns';

import {
  substitute,
  substituteDelimited,
  applyAssign,
  getPath,
} from './template.js';

const { entries, keys, values } = Object;
const { isArray } = Array;

export const EFFECT_KINDS = harden(['ask', 'invoke', 'spawn', 'after', 'emit']);
export const EXIT_EFFECT_KINDS = harden(['invoke', 'emit']);

const REGIONS_SETTLED = 'regions-settled';
const STATE_DONE = 'state-done';

// #region validation

const isRecord = specimen =>
  specimen !== null && typeof specimen === 'object' && !isArray(specimen);

const assertStateName = (name, where) => {
  (typeof name === 'string' && name.length > 0) ||
    Fail`${q(where)}: state name must be a non-empty string, got ${q(name)}`;
  !name.startsWith('#') ||
    Fail`${q(where)}: state name must not begin with '#', got ${q(name)}`;
};

const assertEffect = (effect, where, { exit = false } = {}) => {
  isRecord(effect) || Fail`${q(where)}: effect must be a record`;
  const { kind } = effect;
  EFFECT_KINDS.includes(kind) ||
    Fail`${q(where)}: unknown effect kind ${q(kind)}`;
  !exit ||
    EXIT_EFFECT_KINDS.includes(kind) ||
    Fail`${q(where)}: exit effects may not ${q(kind)} — compensation must not block on the world`;
  if (kind === 'ask') {
    typeof effect.to === 'string' ||
      isRecord(effect.to) ||
      Fail`${q(where)}: ask.to must be an endowment name or template`;
    const hasWhat = effect.what !== undefined;
    const hasForm = effect.form !== undefined;
    hasWhat !== hasForm ||
      Fail`${q(where)}: ask takes exactly one of what | form`;
    if (hasWhat) {
      (isRecord(effect.what) && typeof effect.what.description === 'string') ||
        Fail`${q(where)}: ask.what.description must be a string`;
    } else {
      (isRecord(effect.form) &&
        typeof effect.form.description === 'string' &&
        isArray(effect.form.fields)) ||
        Fail`${q(where)}: ask.form needs description and fields`;
    }
    typeof effect.outcome === 'string' ||
      Fail`${q(where)}: ask.outcome must be an event type`;
  } else if (kind === 'invoke') {
    typeof effect.target === 'string' ||
      isRecord(effect.target) ||
      Fail`${q(where)}: invoke.target must be an endowment name or template`;
    typeof effect.method === 'string' ||
      Fail`${q(where)}: invoke.method must be a string`;
    effect.args === undefined ||
      isArray(effect.args) ||
      Fail`${q(where)}: invoke.args must be an array`;
    typeof effect.outcome === 'string' ||
      Fail`${q(where)}: invoke.outcome must be an event type`;
  } else if (kind === 'after') {
    const { ms } = effect;
    const hasMs = ms !== undefined;
    const hasAt = effect.at !== undefined;
    hasMs !== hasAt || Fail`${q(where)}: after takes exactly one of ms | at`;
    !hasMs ||
      (typeof ms === 'number' && Number.isInteger(ms) && ms > 0) ||
      Fail`${q(where)}: after.ms must be a positive integer`;
    !hasAt ||
      typeof effect.at === 'string' ||
      Fail`${q(where)}: after.at must be an ISO date string`;
    (isRecord(effect.emit) && typeof effect.emit.type === 'string') ||
      Fail`${q(where)}: after.emit must be an event record with a type`;
  } else if (kind === 'emit') {
    (isRecord(effect.event) && typeof effect.event.type === 'string') ||
      Fail`${q(where)}: emit.event must be an event record with a type`;
  } else if (kind === 'spawn') {
    typeof effect.chart === 'string' ||
      isRecord(effect.chart) ||
      Fail`${q(where)}: spawn.chart must be a chart or an installed chart key`;
    effect.endowments === undefined ||
      (isArray(effect.endowments) &&
        effect.endowments.every(name => typeof name === 'string')) ||
      Fail`${q(where)}: spawn.endowments must be an array of endowment names`;
    typeof effect.outcome === 'string' ||
      Fail`${q(where)}: spawn.outcome must be an event type`;
  }
  effect.failure === undefined ||
    typeof effect.failure === 'string' ||
    Fail`${q(where)}: effect.failure must be an event type`;
};

const assertTransition = (t, siblings, where) => {
  isRecord(t) || Fail`${q(where)}: transition must be a record`;
  if (t.when !== undefined) {
    assertPattern(t.when);
  }
  if (t.target !== undefined) {
    typeof t.target === 'string' ||
      Fail`${q(where)}: transition target must be a state name`;
    siblings[t.target] !== undefined ||
      Fail`${q(where)}: transition target ${q(t.target)} is not a sibling state`;
  }
  t.assign === undefined ||
    isRecord(t.assign) ||
    Fail`${q(where)}: transition assign must be a record`;
  if (t.effects !== undefined) {
    isArray(t.effects) ||
      Fail`${q(where)}: transition effects must be an array`;
    t.effects.forEach((effect, i) =>
      assertEffect(effect, `${where}.effects[${i}]`),
    );
  }
};

const assertStates = (states, initial, where) => {
  isRecord(states) || Fail`${q(where)}: states must be a record`;
  keys(states).length > 0 || Fail`${q(where)}: states must be non-empty`;
  typeof initial === 'string' || Fail`${q(where)}: initial must name a state`;
  states[initial] !== undefined ||
    Fail`${q(where)}: initial ${q(initial)} is not a declared state`;
  for (const [name, def] of entries(states)) {
    assertStateName(name, where);
    const at = `${where}.${name}`;
    isRecord(def) || Fail`${q(at)}: state must be a record`;
    (def.entry ?? []).forEach((effect, i) =>
      assertEffect(effect, `${at}.entry[${i}]`),
    );
    (def.exit ?? []).forEach((effect, i) =>
      assertEffect(effect, `${at}.exit[${i}]`, { exit: true }),
    );
    if (def.on !== undefined) {
      isRecord(def.on) || Fail`${q(at)}: on must be a record`;
      for (const [type, candidates] of entries(def.on)) {
        isArray(candidates) ||
          Fail`${q(at)}.on.${q(type)}: transitions must be an array`;
        candidates.forEach((t, i) =>
          assertTransition(t, states, `${at}.on.${type}[${i}]`),
        );
      }
    }
    const { regions } = def;
    const hasChild = def.states !== undefined;
    const hasRegions = regions !== undefined;
    !(hasChild && hasRegions) ||
      Fail`${q(at)}: a state nests children or regions, not both`;
    if (hasChild) {
      assertStates(def.states, def.initial, at);
    }
    if (hasRegions) {
      if (isArray(regions)) {
        regions.length > 0 || Fail`${q(at)}: regions must be non-empty`;
        regions.forEach((regionChart, i) => {
          assertChartBody(regionChart, `${at}#${i}`);
          assertRegionFinals(regionChart, `${at}#${i}`);
        });
      } else {
        isRecord(regions) ||
          Fail`${q(at)}: regions must be an array or an $eachParam record`;
        typeof regions.$eachParam === 'string' ||
          Fail`${q(at)}: regions.$eachParam must be a params path`;
        isRecord(regions.chart) ||
          Fail`${q(at)}: regions.chart must be an inline chart (resolve installed chart keys before validation)`;
        regions.input === undefined ||
          isRecord(regions.input) ||
          Fail`${q(at)}: regions.input must be a template record`;
        assertChartBody(regions.chart, `${at}#each`);
        assertRegionFinals(regions.chart, `${at}#each`);
      }
      def.join === undefined ||
        def.join === 'counts' ||
        Fail`${q(at)}: join must be 'counts'`;
    }
    if (def.final === true) {
      (!hasChild && !hasRegions) || Fail`${q(at)}: a final state may not nest`;
      def.on === undefined || Fail`${q(at)}: a final state has no transitions`;
      (def.entry ?? []).length === 0 ||
        Fail`${q(at)}: a final state has no entry effects`;
    }
  }
};

// The join envelope's `counts` record reserves `pending` for the
// unsettled-region count; a region final state of that name would be
// clobbered by the spread in `makeJoinEvent`.
const assertRegionFinals = (regionChart, where) => {
  for (const [name, def] of entries(regionChart.states)) {
    !(def.final === true && name === 'pending') ||
      Fail`${q(where)}: a region final state may not be named 'pending' (reserved join-count key)`;
  }
};

const assertChartBody = (chart, where) => {
  isRecord(chart) || Fail`${q(where)}: chart must be a record`;
  chart.context === undefined ||
    isRecord(chart.context) ||
    Fail`${q(where)}: chart context must be a record`;
  assertStates(chart.states, chart.initial, where);
};

/**
 * Validate a chart structurally. Throws with a path-labeled diagnostic on
 * the first violation. Region charts must be inline (the service resolves
 * installed chart keys before validation and storage, so a run's chart
 * snapshot is always self-contained).
 *
 * @param {any} chart
 */
export const assertChart = chart => {
  isRecord(chart) || Fail`chart must be a record`;
  const { name } = chart;
  (typeof name === 'string' && name.length > 0) ||
    Fail`chart.name must be a non-empty string`;
  typeof chart.version === 'number' || Fail`chart.version must be a number`;
  if (chart.params !== undefined) {
    assertPattern(chart.params);
  }
  if (chart.ports !== undefined) {
    isRecord(chart.ports) || Fail`chart.ports must be a record`;
    for (const pattern of values(chart.ports)) {
      assertPattern(pattern);
    }
  }
  assertChartBody(chart, chart.name);
};
harden(assertChart);

/**
 * Static diagnostics beyond structural validity, mirroring the engine's
 * runtime policy:
 *
 * - **error** — an `ask` / `invoke` / `spawn` effect whose `outcome` (or
 *   explicit `failure`) event type is handled by no state along the
 *   effect's owner path. The engine fails a run whose settlement fires
 *   no transition, so this is a guaranteed runtime failure.
 * - **warning** — a state unreachable from its level's `initial` via
 *   sibling transition targets; an `after` / `emit` event type with no
 *   handler on its path; a parallel state whose `regions-settled` join
 *   event no state on the path handles.
 *
 * The handling check is structural (a type appears in some `on` along
 * the owner chain); guard totality remains a runtime concern, which the
 * engine's fail-loud settlement covers. Event types containing `{` are
 * dynamic (interpolated) and are skipped. Exit effects are compensation
 * and are not checked.
 *
 * @param {any} chart
 * @returns {{ errors: string[], warnings: string[] }}
 */
export const chartDiagnostics = chart => {
  assertChart(chart);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  /**
   * @param {Set<string>[]} chain - handled-type sets, outermost first
   * @param {string} type
   */
  const handled = (chain, type) =>
    type.includes('{') || chain.some(set => set.has(type));

  const checkEffect = (effect, chain, where) => {
    const { kind } = effect;
    if (kind === 'ask' || kind === 'invoke' || kind === 'spawn') {
      if (!handled(chain, effect.outcome)) {
        errors.push(
          `${where}: ${kind} outcome '${effect.outcome}' is handled by no state on its path`,
        );
      }
      if (effect.failure !== undefined && !handled(chain, effect.failure)) {
        errors.push(
          `${where}: ${kind} failure '${effect.failure}' is handled by no state on its path`,
        );
      }
    } else if (kind === 'after') {
      if (!handled(chain, effect.emit.type)) {
        warnings.push(
          `${where}: after emits '${effect.emit.type}', handled by no state on its path`,
        );
      }
    } else if (kind === 'emit') {
      if (!handled(chain, effect.event.type)) {
        warnings.push(
          `${where}: emit '${effect.event.type}' is handled by no state on its path`,
        );
      }
    }
  };

  /**
   * @param {Record<string, any>} states
   * @param {string} initial
   * @param {Set<string>[]} chain
   * @param {string} where
   */
  const walkStates = (states, initial, chain, where) => {
    const reachable = new Set([initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const name of [...reachable]) {
        for (const candidates of values(states[name].on ?? {})) {
          for (const t of candidates) {
            if (t.target !== undefined && !reachable.has(t.target)) {
              reachable.add(t.target);
              grew = true;
            }
          }
        }
      }
    }
    for (const name of keys(states)) {
      if (!reachable.has(name)) {
        warnings.push(
          `${where}.${name}: unreachable from initial '${initial}'`,
        );
      }
    }
    for (const [name, def] of entries(states)) {
      const at = `${where}.${name}`;
      const own = new Set(keys(def.on ?? {}));
      const selfChain = [...chain, own];
      (def.entry ?? []).forEach((effect, i) =>
        checkEffect(effect, selfChain, `${at}.entry[${i}]`),
      );
      for (const [type, candidates] of entries(def.on ?? {})) {
        candidates.forEach((t, i) => {
          const effectChain =
            t.target === undefined
              ? selfChain
              : [...chain, new Set(keys(states[t.target].on ?? {}))];
          (t.effects ?? []).forEach((effect, j) =>
            checkEffect(effect, effectChain, `${at}.on.${type}[${i}][${j}]`),
          );
        });
      }
      if (def.states !== undefined) {
        if (
          values(def.states).some(child => child.final === true) &&
          !handled(selfChain, STATE_DONE)
        ) {
          warnings.push(
            `${at}: compound state's '${STATE_DONE}' completion is handled by no state on its path`,
          );
        }
        walkStates(def.states, def.initial, selfChain, at);
      } else if (def.regions !== undefined) {
        if (!handled(selfChain, REGIONS_SETTLED)) {
          warnings.push(
            `${at}: parallel state's '${REGIONS_SETTLED}' join is handled by no state on its path`,
          );
        }
        if (isArray(def.regions)) {
          def.regions.forEach((regionChart, i) =>
            walkStates(
              regionChart.states,
              regionChart.initial,
              selfChain,
              `${at}#${i}`,
            ),
          );
        } else {
          walkStates(
            def.regions.chart.states,
            def.regions.chart.initial,
            selfChain,
            `${at}#each`,
          );
        }
      }
    }
  };

  walkStates(chart.states, chart.initial, [], chart.name);
  return harden({ errors: harden(errors), warnings: harden(warnings) });
};
harden(chartDiagnostics);

/**
 * Every statically named event type the engine itself can produce for a chart:
 * the internal kernel events plus effect `outcome` / `failure` types, `after`
 * emissions, and `emit` event types. Types containing interpolation syntax are
 * skipped because no finite set of their runtime substitutions can be reserved.
 * Security-sensitive charts should use literal engine event types.
 *
 * @param {any} chart
 * @returns {string[]}
 */
export const engineEventTypes = chart => {
  assertChart(chart);
  /** @type {Set<string>} */
  const types = new Set([
    REGIONS_SETTLED,
    STATE_DONE,
    'effect-failed',
    'cancel-requested',
  ]);
  const addType = type => {
    if (typeof type === 'string' && !type.includes('{')) {
      types.add(type);
    }
  };
  const checkEffect = effect => {
    addType(effect.outcome);
    addType(effect.failure);
    if (effect.kind === 'after') {
      addType(effect.emit.type);
    } else if (effect.kind === 'emit') {
      addType(effect.event.type);
    }
  };
  const walk = states => {
    for (const def of values(states)) {
      (def.entry ?? []).forEach(checkEffect);
      (def.exit ?? []).forEach(checkEffect);
      for (const candidates of values(def.on ?? {})) {
        for (const t of candidates) {
          (t.effects ?? []).forEach(checkEffect);
        }
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
  return harden([...types].sort());
};
harden(engineEventTypes);

// #endregion

// #region effect substitution

/**
 * Substitute the templated positions of an effect description. A spawned
 * child chart is deliberately not substituted — its strings belong to the
 * child's own scope, not the parent's. An `after` effect's `emit` event
 * is substituted at declaration time, so the event it eventually fires
 * carries the context as of arming, not of firing.
 *
 * An ask's `what` / `form` are participant-facing text, so their string
 * interpolations render delimited: substituted content reads as quoted
 * data to the human or LLM agent receiving the ask, and cannot
 * masquerade as workflow instruction. The `to` endowment name uses plain
 * interpolation (it names a slot, not prose).
 *
 * @param {any} effect
 * @param {import('./template.js').TemplateScope} scope
 */
const substituteEffect = (effect, scope) => {
  const { kind } = effect;
  if (kind === 'ask') {
    return harden({
      ...effect,
      to: substitute(effect.to, scope),
      ...(effect.what !== undefined
        ? { what: substituteDelimited(effect.what, scope) }
        : {}),
      ...(effect.form !== undefined
        ? { form: substituteDelimited(effect.form, scope) }
        : {}),
    });
  }
  if (kind === 'invoke') {
    return harden({
      ...effect,
      target: substitute(effect.target, scope),
      args:
        effect.args === undefined ? harden([]) : substitute(effect.args, scope),
    });
  }
  if (kind === 'emit') {
    return harden({ ...effect, event: substitute(effect.event, scope) });
  }
  if (kind === 'after') {
    return harden({ ...effect, emit: substitute(effect.emit, scope) });
  }
  if (kind === 'spawn') {
    return harden({
      ...effect,
      params:
        effect.params === undefined
          ? harden({})
          : substitute(effect.params, scope),
    });
  }
  throw Fail`unknown effect kind ${q(kind)}`;
};

// #endregion

// #region configuration

// The region specs of a parallel state: literal region charts carry the
// frame's params; `$eachParam` regions get one instance per array
// element, with `item` / `index` — and the optional `input` template,
// substituted against the entering scope so context values (a submitted
// head ref, say) can flow into region params — merged in.
const regionSpecsOf = (def, scope) => {
  const { params } = scope;
  if (isArray(def.regions)) {
    return def.regions.map(chart => ({ chart, params }));
  }
  const items = getPath(params, def.regions.$eachParam);
  isArray(items) ||
    Fail`regions.$eachParam ${q(def.regions.$eachParam)} must select an array from params, got ${q(items)}`;
  const input =
    def.regions.input === undefined
      ? harden({})
      : substitute(def.regions.input, scope);
  return items.map((item, index) => ({
    chart: def.regions.chart,
    params: harden({ ...params, ...input, item, index }),
  }));
};

// The chart of region `i` of a parallel state definition.
const regionChartOf = (def, i) =>
  isArray(def.regions) ? def.regions[i] : def.regions.chart;

/**
 * The `regions-settled` join envelope extras for a parallel state:
 * `counts` pre-populated with a zero for every top-level final state name
 * of every region chart (so `M.eq(0)` guards can match) plus `pending`,
 * and `outcomes` listing settled regions in index order.
 *
 * @param {any} def
 * @param {any[]} regions
 * @param {string[]} path
 */
const makeJoinEvent = (def, regions, path) => {
  /** @type {Record<string, number>} */
  const counts = {};
  for (let i = 0; i < regions.length; i += 1) {
    const regionChart = regionChartOf(def, i);
    for (const [stateName, stateDef] of entries(regionChart.states)) {
      if (stateDef.final === true && counts[stateName] === undefined) {
        counts[stateName] = 0;
      }
    }
  }
  let pending = 0;
  const outcomes = [];
  regions.forEach((region, index) => {
    if (region.done) {
      counts[region.config.state] = (counts[region.config.state] ?? 0) + 1;
      outcomes.push(
        harden({
          index,
          state: region.config.state,
          ...(region.output !== undefined ? { output: region.output } : {}),
        }),
      );
    } else {
      pending += 1;
    }
  });
  return harden({
    type: REGIONS_SETTLED,
    path: harden([...path]),
    counts: harden({ ...counts, pending }),
    outcomes: harden(outcomes),
  });
};

// Enter a state: build its configuration node, collecting entry effects
// (outermost first, tagged with their owner path) and any immediately
// settled regions' join event into `out`.
const enterState = (states, name, frame, eventEnvelope, parentPath, out) => {
  const def = states[name] ?? Fail`no state ${q(name)} under ${q(parentPath)}`;
  const path = harden([...parentPath, name]);
  const scope = { params: frame.params, ctx: frame.ctx, event: eventEnvelope };
  for (const effect of def.entry ?? []) {
    out.effects.push(harden({ path, effect: substituteEffect(effect, scope) }));
  }
  /** @type {any} */
  const node = { state: name };
  if (def.states !== undefined) {
    node.child = enterState(
      def.states,
      def.initial,
      frame,
      eventEnvelope,
      path,
      out,
    );
    const initialDef = def.states[def.initial];
    if (initialDef.final === true) {
      // The compound's initial child is already final: raise
      // `state-done` immediately, exactly as an immediately-settled
      // region raises its join — otherwise the compound wedges with
      // nothing pending.
      out.internals.push(
        harden({
          type: STATE_DONE,
          path: harden([...path]),
          value: harden({
            state: def.initial,
            ...(initialDef.output !== undefined
              ? { output: substitute(initialDef.output, scope) }
              : {}),
          }),
        }),
      );
    }
  } else if (def.regions !== undefined) {
    const specs = regionSpecsOf(def, scope);
    node.regions = specs.map(({ chart: regionChart, params }, i) => {
      const regionFrame = { params, ctx: harden(regionChart.context ?? {}) };
      const regionPath = harden([...path, `#${i}`]);
      const config = enterState(
        regionChart.states,
        regionChart.initial,
        regionFrame,
        eventEnvelope,
        regionPath,
        out,
      );
      const topDef = regionChart.states[config.state];
      const done = topDef.final === true;
      return harden({
        params,
        context: regionFrame.ctx,
        config,
        done,
        ...(done && topDef.output !== undefined
          ? {
              output: substitute(topDef.output, {
                params,
                ctx: regionFrame.ctx,
                event: eventEnvelope,
              }),
            }
          : {}),
      });
    });
    if (node.regions.some(region => region.done)) {
      out.internals.push(makeJoinEvent(def, node.regions, path));
    }
  }
  return harden(node);
};

// All active state nodes of a configuration subtree, deepest first, each
// with its path, definition, and owning frame — for exit-effect ordering
// and pending-effect pruning. Settled regions are no longer active.
const activeNodes = (states, config, basePath, frame) => {
  const def = states[config.state];
  const path = [...basePath, config.state];
  /** @type {any[]} */
  const deeper = [];
  if (config.child !== undefined) {
    deeper.push(...activeNodes(def.states, config.child, path, frame));
  } else if (config.regions !== undefined) {
    config.regions.forEach((region, i) => {
      if (!region.done) {
        const regionChart = regionChartOf(def, i);
        deeper.push(
          ...activeNodes(
            regionChart.states,
            region.config,
            [...path, `#${i}`],
            { params: region.params, ctx: region.context },
          ),
        );
      }
    });
  }
  return [...deeper, { path: harden(path), def, frame }];
};

// #endregion

// #region stepping

const tryCandidates = (def, envelope) => {
  /** @type {any[] | undefined} */
  const candidates = def.on?.[envelope.type];
  if (candidates === undefined) {
    return undefined;
  }
  for (let i = 0; i < candidates.length; i += 1) {
    const t = candidates[i];
    if (t.when === undefined || matches(envelope, t.when)) {
      return { transition: t, index: i };
    }
  }
  return undefined;
};

// Fire a transition declared on the state at `path` (whose siblings are
// `states`), returning the replacement configuration node for that level
// (or the same node for an internal transition). Context changes land on
// the mutable `frame`.
const fire = (states, config, found, frame, envelope, path, out) => {
  const { transition: t } = found;
  if (t.assign !== undefined) {
    const scope = { params: frame.params, ctx: frame.ctx, event: envelope };
    const patch = applyAssign(t.assign, frame.ctx, scope);
    frame.ctx = harden({ ...frame.ctx, ...patch });
  }
  // Effects — exit, transition, and entry alike — see the post-assign
  // context.
  const scope = { params: frame.params, ctx: frame.ctx, event: envelope };
  if (t.target === undefined) {
    for (const effect of t.effects ?? []) {
      out.effects.push(
        harden({ path, effect: substituteEffect(effect, scope) }),
      );
    }
    return { config, enteredFinal: undefined };
  }
  const parentPath = path.slice(0, -1);
  for (const node of activeNodes(states, config, parentPath, frame)) {
    out.exited.push(node.path);
    const nodeScope =
      node.frame === undefined || node.frame === frame
        ? scope
        : { params: node.frame.params, ctx: node.frame.ctx, event: envelope };
    for (const effect of node.def.exit ?? []) {
      // Exit effects are compensation at a path that is dead by the time
      // they settle; the `exit` mark tells the engine their settlements
      // are allowed to fall on deaf ears.
      out.effects.push(
        harden({
          path: node.path,
          exit: true,
          effect: substituteEffect(effect, nodeScope),
        }),
      );
    }
  }
  const targetPath = harden([...parentPath, t.target]);
  for (const effect of t.effects ?? []) {
    out.effects.push(
      harden({ path: targetPath, effect: substituteEffect(effect, scope) }),
    );
  }
  const entered = enterState(
    states,
    t.target,
    frame,
    envelope,
    parentPath,
    out,
  );
  const targetDef = states[t.target];
  const enteredFinal =
    targetDef.final === true
      ? harden({
          state: t.target,
          ...(targetDef.output !== undefined
            ? {
                output: substitute(targetDef.output, {
                  params: frame.params,
                  ctx: frame.ctx,
                  event: envelope,
                }),
              }
            : {}),
        })
      : undefined;
  return { config: entered, enteredFinal };
};

/**
 * Step one level of one machine frame. `route` is the remaining routed
 * path segments (undefined to broadcast); a routed envelope descends only
 * while the route matches the active configuration and is offered to the
 * states of the matched prefix, innermost-out.
 *
 * @param {Record<string, any>} states
 * @param {any} config
 * @param {{ params: any, ctx: any }} frame
 * @param {any} envelope
 * @param {string[]} basePath
 * @param {string[] | undefined} route
 * @param {{ effects: any[], internals: any[], exited: string[][] }} out
 */
const stepLevel = (states, config, frame, envelope, basePath, route, out) => {
  const def = states[config.state];
  const path = [...basePath, config.state];
  const routed = route !== undefined;
  if (routed && route[0] !== config.state) {
    // The route diverged: the owner state is no longer active here.
    return { fired: false, config, enteredFinal: undefined };
  }
  const innerRoute = routed ? route.slice(1) : undefined;
  const descend = innerRoute === undefined || innerRoute.length > 0;
  let fired = false;
  let nextConfig = config;

  if (descend && config.regions !== undefined) {
    const targetIndex =
      innerRoute !== undefined && innerRoute[0].startsWith('#')
        ? Number(innerRoute[0].slice(1))
        : undefined;
    const regionRoute =
      innerRoute !== undefined && targetIndex !== undefined
        ? innerRoute.slice(1)
        : undefined;
    const before = config.regions;
    let regionsChanged = false;
    const nextRegions = before.map((region, i) => {
      if (region.done || (routed && targetIndex !== i)) {
        return region;
      }
      const regionChart = regionChartOf(def, i);
      const regionFrame = { params: region.params, ctx: region.context };
      const result = stepLevel(
        regionChart.states,
        region.config,
        regionFrame,
        envelope,
        [...path, `#${i}`],
        routed ? regionRoute : undefined,
        out,
      );
      if (!result.fired) {
        return region;
      }
      fired = true;
      regionsChanged = true;
      const done = result.enteredFinal !== undefined;
      return harden({
        params: region.params,
        context: regionFrame.ctx,
        config: result.config,
        done,
        ...(result.enteredFinal !== undefined &&
        result.enteredFinal.output !== undefined
          ? { output: result.enteredFinal.output }
          : {}),
      });
    });
    if (regionsChanged) {
      nextConfig = harden({ state: config.state, regions: nextRegions });
      const newlySettled = nextRegions.some(
        (region, i) => region.done && !before[i].done,
      );
      if (newlySettled) {
        out.internals.push(makeJoinEvent(def, nextRegions, path));
      }
    }
  } else if (descend && config.child !== undefined) {
    const result = stepLevel(
      def.states,
      config.child,
      frame,
      envelope,
      path,
      innerRoute,
      out,
    );
    if (result.fired) {
      fired = true;
      nextConfig = harden({ state: config.state, child: result.config });
      if (result.enteredFinal !== undefined) {
        // A nested compound's child reached a final state: raise
        // `state-done` at this compound so its transitions can react.
        out.internals.push(
          harden({
            type: STATE_DONE,
            path: harden([...path]),
            value: result.enteredFinal,
          }),
        );
      }
    }
  }

  if (!fired) {
    const found = tryCandidates(def, envelope);
    if (found !== undefined) {
      const result = fire(states, config, found, frame, envelope, path, out);
      return {
        fired: true,
        config: result.config,
        enteredFinal: result.enteredFinal,
      };
    }
  }
  return { fired, config: nextConfig, enteredFinal: undefined };
};

// #endregion

// #region public surface

/**
 * @typedef {object} StepResult
 * @property {boolean} fired
 * @property {any} configuration
 * @property {Record<string, any>} context
 * @property {{ path: string[], effect: any }[]} effects - substituted
 *   effect descriptions tagged with their owner state path, in exit →
 *   transition → entry order
 * @property {any[]} internalEvents - engine-generated events
 *   (`regions-settled`, `state-done`) for the caller to journal and step
 * @property {string[][]} exited - exited state paths, deepest first, for
 *   pending-effect pruning
 * @property {{ state: string, output?: any } | undefined} terminal - set
 *   when the machine's top level entered a final state
 */

/**
 * Enter a chart's initial state. Validates `params` against the chart's
 * `params` pattern when one is declared.
 *
 * @param {any} chart
 * @param {{ params?: Record<string, any> }} [options]
 * @returns {StepResult}
 */
export const initialStep = (chart, { params = harden({}) } = {}) => {
  assertChart(chart);
  if (chart.params !== undefined) {
    mustMatch(params, chart.params, 'workflow params');
  }
  const frame = { params, ctx: harden(chart.context ?? {}) };
  const out = { effects: [], internals: [], exited: [] };
  const configuration = enterState(
    chart.states,
    chart.initial,
    frame,
    undefined,
    [],
    out,
  );
  const initialDef = chart.states[chart.initial];
  const terminal =
    initialDef.final === true
      ? harden({
          state: chart.initial,
          ...(initialDef.output !== undefined
            ? {
                output: substitute(initialDef.output, {
                  params,
                  ctx: frame.ctx,
                  event: undefined,
                }),
              }
            : {}),
        })
      : undefined;
  return harden({
    fired: true,
    configuration,
    context: frame.ctx,
    effects: harden(out.effects),
    internalEvents: harden(out.internals),
    exited: harden(out.exited),
    terminal,
  });
};
harden(initialStep);

/**
 * Apply one event envelope to a machine state. Pure and synchronous.
 *
 * @param {any} chart
 * @param {{ configuration: any, context: Record<string, any>, params: Record<string, any> }} state
 * @param {any} envelope - `{ type, value?, by, at, path?, ... }`
 * @returns {StepResult}
 */
export const transition = (chart, state, envelope) => {
  isRecord(envelope) ||
    Fail`event envelope must be a record, got ${q(envelope)}`;
  typeof envelope.type === 'string' ||
    Fail`event envelope must have a string type`;
  const frame = { params: state.params, ctx: state.context };
  const out = { effects: [], internals: [], exited: [] };
  const route = envelope.path === undefined ? undefined : [...envelope.path];
  const result = stepLevel(
    chart.states,
    state.configuration,
    frame,
    envelope,
    [],
    route,
    out,
  );
  return harden({
    fired: result.fired,
    configuration: result.config,
    context: frame.ctx,
    effects: harden(out.effects),
    internalEvents: harden(out.internals),
    exited: harden(out.exited),
    terminal: result.enteredFinal,
  });
};
harden(transition);

/**
 * Collect the exit effects of every active state of a configuration,
 * deepest first — the compensation set `cancel` runs. Exit effects are
 * restricted to `invoke` and `emit` by `assertChart`, so compensation
 * never blocks on a person.
 *
 * @param {any} chart
 * @param {{ configuration: any, context: Record<string, any>, params: Record<string, any> }} state
 * @returns {{ path: string[], effect: any }[]}
 */
export const exitEffects = (chart, state) => {
  const rootFrame = { params: state.params, ctx: state.context };
  const nodes = activeNodes(chart.states, state.configuration, [], rootFrame);
  /** @type {{ path: string[], effect: any }[]} */
  const effects = [];
  for (const node of nodes) {
    const frame = node.frame ?? rootFrame;
    const scope = { params: frame.params, ctx: frame.ctx, event: undefined };
    for (const effect of node.def.exit ?? []) {
      effects.push(
        harden({
          path: node.path,
          exit: true,
          effect: substituteEffect(effect, scope),
        }),
      );
    }
  }
  return harden(effects);
};
harden(exitEffects);

/**
 * The active state paths of a configuration, deepest first.
 *
 * @param {any} chart
 * @param {any} configuration
 * @returns {string[][]}
 */
export const activePaths = (chart, configuration) =>
  harden(
    activeNodes(chart.states, configuration, [], undefined).map(
      node => node.path,
    ),
  );
harden(activePaths);

// #endregion
