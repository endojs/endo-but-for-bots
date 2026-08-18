// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { M } from '@endo/patterns';
import {
  assertChart,
  initialStep,
  transition,
  exitEffects,
  activePaths,
} from '../src/machine.js';
import {
  getPath,
  substitute,
  interpolate,
  applyAssign,
} from '../src/template.js';
import { foldJournal, effectRecordsFor } from '../src/journal.js';

const env = (type, extra = {}) =>
  harden({ type, by: 'test', at: '2026-08-17T00:00:00Z', ...extra });

// #region template

test('getPath walks records and arrays totally', t => {
  const root = harden({ a: { b: [10, { c: 'deep' }] } });
  t.is(getPath(root, 'a.b.1.c'), 'deep');
  t.is(getPath(root, 'a.b.0'), 10);
  t.is(getPath(root, ''), root);
  t.is(getPath(root, 'a.x.y'), undefined);
  t.is(getPath(root, 'a.b.9'), undefined);
});

test('substitute replaces value forms and interpolates strings', t => {
  const scope = harden({
    params: { title: 'Fix login', n: 2 },
    ctx: { round: 3 },
    event: { value: { ok: true } },
  });
  t.is(substitute(harden({ $params: 'title' }), scope), 'Fix login');
  t.deepEqual(substitute(harden({ $event: 'value' }), scope), { ok: true });
  t.is(
    substitute('round {$ctx.round} of {$params.title}', scope),
    'round 3 of Fix login',
  );
  const record = substitute(
    harden({ deep: [{ $ctx: 'round' }, 'n={$params.n}'] }),
    scope,
  );
  t.deepEqual(record, { deep: [3, 'n=2'] });
  // Patterns pass through untouched.
  const pattern = M.string();
  t.is(substitute(pattern, scope), pattern);
  t.throws(() => substitute(harden({ $inc: 1 }), scope), {
    message: /\$inc.*only meaningful/,
  });
});

test('interpolate renders structured values readably', t => {
  const scope = harden({ ctx: { feedback: ['too slow', { area: 'auth' }] } });
  t.is(
    interpolate('prior: {$ctx.feedback}', scope),
    'prior: [too slow, { area: auth }]',
  );
  t.is(interpolate('missing: <{$ctx.nope}>', scope), 'missing: <>');
});

test('applyAssign merges templates and $inc', t => {
  const ctx = harden({ round: 1, keep: 'yes' });
  const scope = harden({ params: {}, ctx, event: { value: 'v' } });
  const patch = applyAssign(
    harden({ round: { $inc: 2 }, got: { $event: 'value' } }),
    ctx,
    scope,
  );
  t.deepEqual(patch, { round: 3, got: 'v' });
});

// #endregion

// #region validation

test('assertChart rejects malformed charts with labeled diagnostics', t => {
  const base = {
    name: 'bad',
    version: 1,
    initial: 'a',
    states: { a: { final: true } },
  };
  t.notThrows(() => assertChart(harden(base)));
  t.throws(() => assertChart(harden({ ...base, initial: 'zap' })), {
    message: /initial "zap" is not a declared state/,
  });
  t.throws(
    () =>
      assertChart(
        harden({
          ...base,
          states: {
            a: { on: { go: [{ target: 'missing' }] } },
          },
        }),
      ),
    { message: /target "missing" is not a sibling state/ },
  );
  t.throws(
    () =>
      assertChart(
        harden({
          ...base,
          states: { a: { entry: [{ kind: 'teleport' }] } },
        }),
      ),
    { message: /unknown effect kind "teleport"/ },
  );
  t.throws(
    () =>
      assertChart(
        harden({
          ...base,
          states: {
            a: {
              exit: [
                {
                  kind: 'ask',
                  to: 'x',
                  what: { description: 'd' },
                  outcome: 'o',
                },
              ],
            },
          },
        }),
      ),
    { message: /exit effects may not "ask"/ },
  );
  t.throws(
    () =>
      assertChart(
        harden({
          ...base,
          states: { a: { final: true, on: { go: [] } } },
        }),
      ),
    { message: /final state has no transitions/ },
  );
});

// #endregion

// #region flat machines

const draftChart = harden({
  name: 'draft-review',
  version: 1,
  params: M.splitRecord({ title: M.string() }),
  context: { attempts: 0 },
  initial: 'draft',
  states: {
    draft: {
      entry: [
        {
          kind: 'ask',
          to: 'writer',
          what: { description: 'Draft {$params.title}' },
          outcome: 'drafted',
        },
      ],
      on: {
        drafted: [{ target: 'review', assign: { draft: { $event: 'value' } } }],
      },
    },
    review: {
      on: {
        reviewed: [
          {
            when: M.splitRecord({
              value: M.splitRecord({ approved: M.eq(true) }),
            }),
            target: 'done',
          },
          { target: 'draft', assign: { attempts: { $inc: 1 } } },
        ],
      },
    },
    done: { final: true, output: { draft: { $ctx: 'draft' } } },
  },
});

test('initialStep validates params, enters initial, substitutes entry effects', t => {
  t.throws(() => initialStep(draftChart, { params: harden({}) }), {
    message: /title/,
  });
  const step = initialStep(draftChart, {
    params: harden({ title: 'Adder' }),
  });
  t.deepEqual(step.configuration, { state: 'draft' });
  t.deepEqual(step.context, { attempts: 0 });
  t.is(step.effects.length, 1);
  t.deepEqual(step.effects[0].path, ['draft']);
  t.is(step.effects[0].effect.what.description, 'Draft "Adder"');
  t.is(step.terminal, undefined);
});

test('transition fires guarded candidates in order and assigns', t => {
  const params = harden({ title: 'Adder' });
  const s0 = initialStep(draftChart, { params });
  const state = {
    configuration: s0.configuration,
    context: s0.context,
    params,
  };
  // Unmatched event type: nothing fires.
  const miss = transition(draftChart, state, env('unrelated'));
  t.false(miss.fired);

  const drafted = transition(
    draftChart,
    state,
    env('drafted', { value: 'the draft' }),
  );
  t.true(drafted.fired);
  t.deepEqual(drafted.configuration, { state: 'review' });
  t.is(drafted.context.draft, 'the draft');
  t.deepEqual(drafted.exited, [['draft']]);

  // Guard mismatch falls to the second candidate.
  const rejected = transition(
    draftChart,
    {
      ...state,
      configuration: drafted.configuration,
      context: drafted.context,
    },
    env('reviewed', { value: { approved: false } }),
  );
  t.true(rejected.fired);
  t.deepEqual(rejected.configuration, { state: 'draft' });
  t.is(rejected.context.attempts, 1);
  // Re-entering draft re-issues its entry ask.
  t.is(rejected.effects.length, 1);
  t.is(rejected.effects[0].effect.kind, 'ask');

  // Guard match takes the first candidate and reaches the terminal state.
  const approved = transition(
    draftChart,
    {
      ...state,
      configuration: drafted.configuration,
      context: drafted.context,
    },
    env('reviewed', { value: { approved: true } }),
  );
  t.true(approved.fired);
  t.deepEqual(approved.configuration, { state: 'done' });
  t.deepEqual(approved.terminal, {
    state: 'done',
    output: { draft: 'the draft' },
  });
});

test('internal transitions run effects without exiting', t => {
  const chart = harden({
    name: 'internal',
    version: 1,
    initial: 'a',
    states: {
      a: {
        on: {
          note: [
            {
              assign: { seen: { $event: 'value' } },
              effects: [{ kind: 'emit', event: { type: 'noted' } }],
            },
          ],
        },
      },
    },
  });
  const s0 = initialStep(chart, {});
  const result = transition(
    chart,
    { configuration: s0.configuration, context: s0.context, params: {} },
    env('note', { value: 42 }),
  );
  t.true(result.fired);
  t.deepEqual(result.configuration, { state: 'a' });
  t.is(result.context.seen, 42);
  t.deepEqual(result.exited, []);
  t.is(result.effects[0].effect.kind, 'emit');
});

// #endregion

// #region nesting

const nestedChart = harden({
  name: 'nested',
  version: 1,
  initial: 'work',
  states: {
    work: {
      initial: 'stepone',
      states: {
        stepone: { on: { next: [{ target: 'steptwo' }] } },
        steptwo: {
          exit: [{ kind: 'emit', event: { type: 'left-two' } }],
          on: { next: [{ target: 'fin' }] },
        },
        fin: { final: true, output: { at: 'inner-done' } },
      },
      on: {
        'state-done': [{ target: 'wrap' }],
        abort: [{ target: 'wrap' }],
      },
    },
    wrap: { final: true },
  },
});

test('compound states enter initial descendants and prefer inner handlers', t => {
  const s0 = initialStep(nestedChart, {});
  t.deepEqual(s0.configuration, {
    state: 'work',
    child: { state: 'stepone' },
  });
  const state = {
    configuration: s0.configuration,
    context: s0.context,
    params: {},
  };
  const one = transition(nestedChart, state, env('next'));
  t.deepEqual(one.configuration, {
    state: 'work',
    child: { state: 'steptwo' },
  });
  const two = transition(
    nestedChart,
    { ...state, configuration: one.configuration },
    env('next'),
  );
  // Inner final raises a routed state-done internal event at the compound.
  t.is(two.internalEvents.length, 1);
  t.like(two.internalEvents[0], {
    type: 'state-done',
    value: { state: 'fin', output: { at: 'inner-done' } },
  });
  t.deepEqual([...two.internalEvents[0].path], ['work']);
  // Exit effects of the exited inner state were collected.
  t.is(two.effects[0].effect.kind, 'emit');
  t.deepEqual(two.effects[0].path, ['work', 'steptwo']);

  const done = transition(
    nestedChart,
    { ...state, configuration: two.configuration },
    two.internalEvents[0],
  );
  t.true(done.fired);
  t.deepEqual(done.terminal, { state: 'wrap' });
});

test('outer transitions exit the whole active subtree', t => {
  const s0 = initialStep(nestedChart, {});
  const result = transition(
    nestedChart,
    { configuration: s0.configuration, context: s0.context, params: {} },
    env('abort'),
  );
  t.true(result.fired);
  t.deepEqual(result.exited, [['work', 'stepone'], ['work']]);
  t.deepEqual(result.configuration, { state: 'wrap' });
});

// #endregion

// #region regions and joins

const verdictRegion = harden({
  name: 'verdict',
  version: 1,
  initial: 'deciding',
  states: {
    deciding: {
      on: {
        verdict: [
          {
            when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'approved',
            assign: { note: { $event: 'value.note' } },
          },
          { target: 'changes', assign: { note: { $event: 'value.note' } } },
        ],
      },
    },
    approved: { final: true, output: { note: { $ctx: 'note' } } },
    changes: { final: true, output: { note: { $ctx: 'note' } } },
  },
});

const reviewChart = harden({
  name: 'review',
  version: 1,
  params: M.splitRecord({ reviewers: M.arrayOf(M.string()) }),
  initial: 'reviewing',
  states: {
    reviewing: {
      regions: { $eachParam: 'reviewers', chart: verdictRegion },
      join: 'counts',
      on: {
        'regions-settled': [
          {
            when: M.splitRecord({
              counts: M.splitRecord({ changes: M.gte(1) }),
            }),
            target: 'revise',
            assign: { outcomes: { $event: 'outcomes' } },
          },
          {
            when: M.splitRecord({
              counts: M.splitRecord({ approved: M.gte(2), pending: M.eq(0) }),
            }),
            target: 'accepted',
          },
        ],
      },
    },
    revise: { final: true, output: { outcomes: { $ctx: 'outcomes' } } },
    accepted: { final: true },
  },
});

const verdictEnv = (path, ok, note) =>
  env('verdict', { value: { ok, note }, path });

test('$eachParam regions instantiate per element with routed delivery', t => {
  const params = harden({ reviewers: ['alice', 'bob', 'carol'] });
  const s0 = initialStep(reviewChart, { params });
  t.is(s0.configuration.regions.length, 3);
  t.is(s0.configuration.regions[1].params.item, 'bob');
  t.is(s0.configuration.regions[1].params.index, 1);
  const paths = activePaths(reviewChart, s0.configuration);
  t.deepEqual(paths[0], ['reviewing', '#0', 'deciding']);

  const state = {
    configuration: s0.configuration,
    context: s0.context,
    params,
  };
  // A routed verdict reaches only region 1; identical sibling regions do
  // not fire on it.
  const one = transition(
    reviewChart,
    state,
    verdictEnv(['reviewing', '#1', 'deciding'], true, 'lgtm'),
  );
  t.true(one.fired);
  t.false(one.configuration.regions[0].done);
  t.true(one.configuration.regions[1].done);
  t.is(one.configuration.regions[1].output.note, 'lgtm');
  t.is(one.internalEvents.length, 1);
  const join1 = one.internalEvents[0];
  t.is(join1.type, 'regions-settled');
  t.deepEqual(join1.counts, { approved: 1, changes: 0, pending: 2 });
  t.deepEqual(join1.outcomes, [
    { index: 1, state: 'approved', output: { note: 'lgtm' } },
  ]);

  // The quorum guard does not fire yet.
  const noQuorum = transition(
    reviewChart,
    { ...state, configuration: one.configuration },
    join1,
  );
  t.false(noQuorum.fired);

  // Second approval reaches the 2-of-3 quorum with pending 1... not yet:
  // pending must be 0 for accept, so a changes verdict routes to revise.
  const two = transition(
    reviewChart,
    { ...state, configuration: one.configuration },
    verdictEnv(['reviewing', '#0', 'deciding'], false, 'needs tests'),
  );
  const join2 = two.internalEvents[0];
  t.deepEqual(join2.counts, { approved: 1, changes: 1, pending: 1 });
  const routed = transition(
    reviewChart,
    { ...state, configuration: two.configuration },
    join2,
  );
  t.true(routed.fired);
  t.deepEqual(routed.configuration.state, 'revise');
  t.deepEqual(routed.terminal, {
    state: 'revise',
    output: {
      outcomes: [
        { index: 0, state: 'changes', output: { note: 'needs tests' } },
        { index: 1, state: 'approved', output: { note: 'lgtm' } },
      ],
    },
  });
  // Exiting the parallel state exits the still-pending region.
  t.true(
    routed.exited.some(path => path.join('/') === 'reviewing/#2/deciding'),
  );
});

test('unanimous approvals reach the quorum transition', t => {
  const params = harden({ reviewers: ['alice', 'bob'] });
  const s0 = initialStep(reviewChart, { params });
  let configuration = s0.configuration;
  let lastJoin;
  for (const [i] of params.reviewers.entries()) {
    const result = transition(
      reviewChart,
      { configuration, context: s0.context, params },
      verdictEnv(['reviewing', `#${i}`, 'deciding'], true, `ok${i}`),
    );
    configuration = result.configuration;
    [lastJoin] = result.internalEvents;
  }
  t.deepEqual(lastJoin.counts, { approved: 2, changes: 0, pending: 0 });
  const accepted = transition(
    reviewChart,
    { configuration, context: s0.context, params },
    lastJoin,
  );
  t.true(accepted.fired);
  t.deepEqual(accepted.terminal, { state: 'accepted' });
});

test('broadcast events may fire multiple regions at once', t => {
  const chart = harden({
    name: 'broadcast',
    version: 1,
    initial: 'p',
    states: {
      p: {
        regions: [
          {
            name: 'r',
            version: 1,
            initial: 'w',
            states: {
              w: { on: { halt: [{ target: 'h' }] } },
              h: { final: true },
            },
          },
          {
            name: 'r2',
            version: 1,
            initial: 'w',
            states: {
              w: { on: { halt: [{ target: 'h' }] } },
              h: { final: true },
            },
          },
        ],
        join: 'counts',
        on: {
          'regions-settled': [
            {
              when: M.splitRecord({
                counts: M.splitRecord({ pending: M.eq(0) }),
              }),
              target: 'done',
            },
          ],
        },
      },
      done: { final: true },
    },
  });
  const s0 = initialStep(chart, {});
  const halted = transition(
    chart,
    { configuration: s0.configuration, context: s0.context, params: {} },
    env('halt'),
  );
  t.true(halted.fired);
  t.true(halted.configuration.regions.every(region => region.done));
  t.is(halted.internalEvents.length, 1);
  t.deepEqual(halted.internalEvents[0].counts, { h: 2, pending: 0 });
});

test('region contexts are isolated from the root context', t => {
  const chart = harden({
    name: 'iso',
    version: 1,
    context: { round: 7 },
    initial: 'p',
    states: {
      p: {
        regions: [
          {
            name: 'r',
            version: 1,
            context: { round: 0 },
            initial: 'w',
            states: {
              w: {
                on: {
                  tick: [{ assign: { round: { $inc: 1 } } }],
                },
              },
            },
          },
        ],
      },
    },
  });
  const s0 = initialStep(chart, {});
  const ticked = transition(
    chart,
    { configuration: s0.configuration, context: s0.context, params: {} },
    env('tick'),
  );
  t.is(ticked.context.round, 7);
  t.is(ticked.configuration.regions[0].context.round, 1);
});

// #endregion

// #region exit effects and fold determinism

test('exitEffects collects compensation deepest-first', t => {
  const s0 = initialStep(nestedChart, {});
  const one = transition(
    nestedChart,
    { configuration: s0.configuration, context: s0.context, params: {} },
    env('next'),
  );
  const compensation = exitEffects(nestedChart, {
    configuration: one.configuration,
    context: one.context,
    params: {},
  });
  t.is(compensation.length, 1);
  t.deepEqual(compensation[0].path, ['work', 'steptwo']);
  t.is(compensation[0].effect.event.type, 'left-two');
});

test('foldJournal reproduces the live state and tolerates snapshots', t => {
  const params = harden({ title: 'Adder' });
  const s0 = initialStep(draftChart, { params });
  let seq = 0n;
  const entries = [];
  const push = fields => {
    entries.push(harden({ seq, at: 't', ...fields }));
    seq += 1n;
  };
  push({
    kind: 'started',
    by: 'control',
    chartName: draftChart.name,
    chartVersion: draftChart.version,
    params,
    endowmentNames: [],
    configuration: s0.configuration,
    context: s0.context,
    effects: effectRecordsFor(0n, s0.effects),
  });
  const drafted = transition(
    draftChart,
    { configuration: s0.configuration, context: s0.context, params },
    env('drafted', { value: 'v1' }),
  );
  push({
    kind: 'effect-settled',
    by: 'engine',
    effectId: '0-0',
    status: 'fulfilled',
    value: 'v1',
  });
  push({
    kind: 'event',
    by: 'ask:writer',
    event: env('drafted', { value: 'v1' }),
    fired: harden({
      configuration: drafted.configuration,
      context: drafted.context,
      exited: drafted.exited,
      effects: effectRecordsFor(2n, drafted.effects),
    }),
  });
  const direct = foldJournal(entries);
  t.deepEqual(direct.configuration, { state: 'review' });
  t.is(direct.context.draft, 'v1');
  t.is(direct.pending.size, 0);

  // Inserting a snapshot mid-journal does not change the fold.
  const withSnapshot = [
    ...entries.slice(0, 2),
    harden({
      seq: 2n,
      at: 't',
      kind: 'snapshot',
      by: 'engine',
      configuration: foldJournal(entries.slice(0, 2)).configuration,
      context: foldJournal(entries.slice(0, 2)).context,
      pending: [...foldJournal(entries.slice(0, 2)).pending.values()],
    }),
    harden({ ...entries[2], seq: 3n }),
  ];
  const folded = foldJournal(withSnapshot);
  t.deepEqual(folded.configuration, direct.configuration);
  t.deepEqual(folded.context, direct.context);
});

// #endregion
