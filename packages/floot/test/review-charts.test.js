// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { matches } from '@endo/patterns';
import { chartDiagnostics, transition } from '@endo/workflow/machine.js';
import { makeSimulator } from '@endo/workflow/src/simulate.js';
import { renderGraph } from '@endo/workflow/src/graph.js';

import {
  reviewCharts,
  reviewedChangeChart,
  reviewedEndoReleaseChart,
  reviewedNixosChangeChart,
} from '../review-charts.js';

const HEAD = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';
const NEXT_HEAD = '59aba752de8ebbbcb485015e9159dcb6d16856e6';

const params = harden({
  title: 'feat(chat): widen the command bar',
  summary: 'One component and its test.',
  reviewers: ['alice', 'bob'],
  base: 'main',
  rounds: 2n,
});

const pendingOf = (sim, kind, extra = {}) =>
  sim
    .pending()
    .find(
      record =>
        record.effect.kind === kind &&
        Object.entries(extra).every(
          ([key, value]) => record.effect[key] === value,
        ),
    );

/**
 * Every pending reviewer ask, in seat order. Region effects carry a `#<i>`
 * segment in their path, which is what distinguishes a panel seat's ask
 * from the implementer's.
 *
 * @param {any} sim
 */
const reviewerAsks = sim =>
  sim
    .pending()
    .filter(
      record =>
        record.effect.kind === 'ask' &&
        record.path.some(segment => segment.startsWith('#')),
    );

const submitHead = (sim, head = HEAD) => {
  const ask = pendingOf(sim, 'ask', { to: 'developer' });
  return sim.settle(ask.effectId, 'fulfilled', harden({ head, notes: 'done' }));
};

const verdict = (sim, approve, feedback) => {
  const asks = reviewerAsks(sim);
  let status;
  for (const ask of asks) {
    status = sim.settle(
      ask.effectId,
      'fulfilled',
      harden({ approve, feedback }),
    );
  }
  return status;
};

test('every review chart passes diagnostics with no errors or warnings', t => {
  for (const chart of reviewCharts) {
    const { errors, warnings } = chartDiagnostics(chart);
    t.deepEqual(errors, [], `${chart.name} errors`);
    t.deepEqual(warnings, [], `${chart.name} warnings`);
  }
});

test('the public chart boundary rejects unusable panels and budgets', t => {
  const invalidParams = [
    harden({ ...params, reviewers: [] }),
    harden({ ...params, reviewers: Array(33).fill('alice') }),
    harden({ ...params, rounds: 0n }),
    harden({ ...params, rounds: 1.5 }),
    harden({ ...params, rounds: Infinity }),
    harden({
      title: params.title,
      summary: params.summary,
      reviewers: params.reviewers,
      rounds: params.rounds,
    }),
  ];
  for (const specimen of invalidParams) {
    t.throws(() => makeSimulator(reviewedChangeChart, { params: specimen }), {
      message: /workflow params/,
    });
  }

  const portShape = reviewedChangeChart.ports.initiator;
  t.true(
    matches(
      harden({ type: 'set-remaining', value: { remaining: 0n } }),
      portShape,
    ),
    'zero is a valid absolute remainder and means no retry',
  );
  for (const remaining of [-1n, 0.1, Infinity, 0x1_0000_0000n]) {
    t.false(
      matches(
        harden({ type: 'set-remaining', value: { remaining } }),
        portShape,
      ),
      `${remaining} is outside the review-budget domain`,
    );
  }
});

test('a unanimous panel carries the head to approved', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });

  // `boot` seeds the budget from params and hands straight on: a chart's
  // initial context is literal data, so `rounds` cannot be read there.
  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 2n);
  t.is(sim.status().context.round, 0n);

  submitHead(sim);
  t.is(sim.status().state, 'review');
  t.is(reviewerAsks(sim).length, 2, 'both seats asked in parallel');

  verdict(sim, true, 'lgtm');
  const status = sim.status();
  t.true(status.done);
  t.is(status.outcome, 'completed');
  t.deepEqual(status.output, { head: HEAD, round: 0n });
  // The happy path never enters the budget gate, so nothing was burnt.
  t.is(status.context.remaining, 2n);
});

test('the panel is waited out in full before a dissent loops back', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });
  submitHead(sim);

  const [first, second] = reviewerAsks(sim);
  sim.settle(
    first.effectId,
    'fulfilled',
    harden({ approve: false, feedback: 'needs a test' }),
  );
  // One dissent is not enough to turn the loop: the run is still in
  // `review` with the other seat outstanding, so the implementer gets the
  // COMBINED report rather than the first complaint alone.
  t.is(sim.status().state, 'review');

  sim.settle(
    second.effectId,
    'fulfilled',
    harden({ approve: true, feedback: 'fine by me' }),
  );

  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.round, 1n);
  t.is(sim.status().context.remaining, 1n, 'the round cost one of two');

  const feedback = sim.status().context.feedback;
  t.is(feedback.length, 2, 'both verdicts reach the implementer');
  t.deepEqual(feedback.map(entry => entry.output.reviewer).sort(), [
    'alice',
    'bob',
  ]);
  t.deepEqual(
    feedback.map(entry => entry.output.approve),
    [false, true],
  );

  // The re-ask quotes the feedback back, delimited.
  const reask = pendingOf(sim, 'ask', { to: 'developer' });
  t.true(reask.effect.what.description.includes('needs a test'));
  t.true(reask.effect.what.description.includes('round 1'));
});

test('a malformed reviewer answer is a dissent, not a failed run', t => {
  const sim = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, reviewers: ['alice'] }),
  });
  submitHead(sim);

  const [ask] = reviewerAsks(sim);
  sim.settle(ask.effectId, 'fulfilled', harden({ approve: true }));

  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 1n);
  t.deepEqual(sim.status().context.feedback, [
    {
      index: 0,
      state: 'changesRequested',
      output: {
        reviewer: 'alice',
        approve: false,
        feedback:
          'malformed verdict; expected { approve: boolean, feedback: string }',
      },
    },
  ]);
});

test('the budget burns down, exhausts, and the operator can extend it', t => {
  const sim = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, rounds: 1n }),
  });

  submitHead(sim);
  verdict(sim, false, 'no');
  // The single round is spent, so the gate parks the run rather than
  // asking the implementer again.
  t.is(sim.status().state, 'exhausted');
  t.is(sim.status().context.remaining, 0n);

  const form = pendingOf(sim, 'ask', { to: 'operator' });
  t.true(form.effect.form.description.includes('review budget'));
  t.is(form.effect.form.fields[0].label, 'Review rounds still available');

  sim.settle(form.effectId, 'fulfilled', harden({ remaining: 2n }));
  t.is(sim.status().state, 'implement', 'extending the budget resumes');
  t.is(sim.status().context.remaining, 2n);

  // And declining abandons the change with a stated reason. Each round is
  // a fresh submission followed by a fresh panel, so both granted rounds
  // have to be spent before the gate parks the run again.
  submitHead(sim, NEXT_HEAD);
  verdict(sim, false, 'still no');
  t.is(sim.status().context.remaining, 1n);
  submitHead(sim, NEXT_HEAD);
  verdict(sim, false, 'still no');
  t.is(sim.status().state, 'exhausted');
  const second = pendingOf(sim, 'ask', { to: 'operator' });
  sim.settle(second.effectId, 'fulfilled', harden({ remaining: 0n }));
  t.true(sim.status().done);
  t.is(sim.status().outcome, 'completed');
  t.is(
    sim.status().output.reason,
    'operator declined to extend the review budget',
  );
});

test('the initiator can raise the budget mid-round without disturbing the ask', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });

  const before = pendingOf(sim, 'ask', { to: 'developer' });
  t.is(sim.status().context.remaining, 2n);

  // An internal transition: it assigns context without exiting the state,
  // so the implementer's pending ask and its deadline survive untouched.
  sim.inject(harden({ type: 'set-remaining', value: { remaining: 9n } }));

  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 9n);
  const after = pendingOf(sim, 'ask', { to: 'developer' });
  t.is(after.effectId, before.effectId, 'the ask was not re-sent');
  t.is(sim.pending().length, 2, 'ask and deadline both still pending');

  // WorkflowControl is intentionally more general than a port, so the chart
  // repeats its public boundary guard and ignores an invalid direct signal.
  sim.inject(harden({ type: 'set-remaining', value: { remaining: 0.5 } }));
  t.is(sim.status().context.remaining, 9n);
  t.is(pendingOf(sim, 'ask', { to: 'developer' }).effectId, before.effectId);
});

test('the budget can be raised while the run waits in review', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });
  submitHead(sim);
  t.is(sim.status().state, 'review');
  const seats = reviewerAsks(sim).map(record => record.effectId);

  sim.inject(harden({ type: 'set-remaining', value: { remaining: 5n } }));
  t.is(sim.status().context.remaining, 5n);
  t.deepEqual(
    reviewerAsks(sim).map(record => record.effectId),
    seats,
    'no seat was re-asked',
  );
});

test('a budget raise survives preview CI and transient policy states', t => {
  const preview = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, rounds: 1n, previewCi: true }),
  });
  submitHead(preview);
  verdict(preview, true, 'lgtm');
  t.is(preview.status().state, 'preview');
  preview.inject(harden({ type: 'set-remaining', value: { remaining: 3n } }));
  preview.settle(
    pendingOf(preview, 'invoke', { method: 'perform' }).effectId,
    'fulfilled',
    harden({ ok: false, log: 'red' }),
  );
  t.is(preview.status().state, 'implement');
  t.is(preview.status().context.remaining, 2n);

  const context = harden({
    round: 1n,
    remaining: 0n,
    head: HEAD,
    files: [],
    feedback: [],
    reason: '',
  });
  const event = harden({
    type: 'set-remaining',
    value: { remaining: 4n },
    by: 'control',
    at: 'now',
  });
  const gate = transition(
    reviewedChangeChart,
    harden({ configuration: { state: 'gate' }, context, params }),
    event,
  );
  t.true(gate.fired);
  t.is(gate.configuration.state, 'implement');
  t.is(gate.context.remaining, 4n);
  const staleBudget = transition(
    reviewedChangeChart,
    harden({
      configuration: gate.configuration,
      context: gate.context,
      params,
    }),
    harden({
      type: 'budget',
      value: { remaining: 0n },
      path: ['gate'],
      by: 'engine',
      at: 'earlier',
    }),
  );
  t.false(staleBudget.fired);
  t.is(staleBudget.configuration.state, 'implement');

  const ready = transition(
    reviewedChangeChart,
    harden({ configuration: { state: 'ready' }, context, params }),
    event,
  );
  t.true(ready.fired);
  t.is(ready.configuration.state, 'ready');
  t.is(ready.context.remaining, 4n);
  t.deepEqual(ready.effects, []);
});

test('a raise delivered to an exhausted run resumes it', t => {
  const sim = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, rounds: 1n }),
  });
  submitHead(sim);
  verdict(sim, false, 'no');
  t.is(sim.status().state, 'exhausted');

  sim.inject(harden({ type: 'set-remaining', value: { remaining: 3n } }));
  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 3n);
});

test('a malformed submission costs a round instead of failing the run', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });
  const ask = pendingOf(sim, 'ask', { to: 'developer' });
  sim.settle(ask.effectId, 'fulfilled', harden({ notes: 'forgot the head' }));

  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 1n);
  t.is(sim.status().context.feedback[0].feedback.includes('no head ref'), true);
});

test('a silent reviewer times out into a withheld approval', t => {
  const sim = makeSimulator(reviewedChangeChart, { params });
  submitHead(sim);

  const [first] = reviewerAsks(sim);
  sim.settle(
    first.effectId,
    'fulfilled',
    harden({ approve: true, feedback: 'ok' }),
  );

  // The second seat never answers; its deadline settles it as a dissent so
  // the wait-for-all join can complete rather than wedging.
  const deadline = sim
    .pending()
    .find(
      record =>
        record.effect.kind === 'after' &&
        record.path.some(s => s.startsWith('#')),
    );
  t.truthy(deadline, 'the silent reviewer retains its deadline');
  if (deadline === undefined) {
    return;
  }
  sim.fireTimer(deadline.effectId);

  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.round, 1n);
  const withheld = sim
    .status()
    .context.feedback.find(entry => entry.output.approve === false);
  t.is(withheld.output.feedback, 'no verdict before the review deadline');
});

test('preview CI is a slot: off by default, gating when enabled', t => {
  const off = makeSimulator(reviewedChangeChart, { params });
  submitHead(off);
  verdict(off, true, 'lgtm');
  t.true(off.status().done, 'no CI performer is named when previewCi is unset');

  const on = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, previewCi: true }),
  });
  submitHead(on);
  verdict(on, true, 'lgtm');
  t.is(on.status().state, 'preview');
  const ci = pendingOf(on, 'invoke', { method: 'perform' });
  t.deepEqual(ci.effect.args, [HEAD]);

  // Red CI costs a round and returns the report to the implementer.
  on.settle(
    ci.effectId,
    'fulfilled',
    harden({ ok: false, log: 'tests failed' }),
  );
  t.is(on.status().state, 'implement');
  t.is(on.status().context.remaining, 1n);
});

test('green preview CI carries the change on to approval', t => {
  const sim = makeSimulator(reviewedChangeChart, {
    params: harden({ ...params, previewCi: true }),
  });
  submitHead(sim);
  verdict(sim, true, 'lgtm');
  const ci = pendingOf(sim, 'invoke', { method: 'perform' });
  sim.settle(ci.effectId, 'fulfilled', harden({ ok: true, log: 'green' }));
  t.true(sim.status().done);
  t.deepEqual(sim.status().output, { head: HEAD, round: 0n });
});

test('a deploy is proposed only through a passed review', t => {
  // The structural gate. `proposing` spawns the deploy chart, and with it
  // the operator approval that IS the proposal. It has two inbound edges —
  // preview CI disabled, and preview CI green — and the invariant that
  // matters is that BOTH lie downstream of a passed review: `ready` is
  // entered only by the unanimous-approval join, `preview` only from
  // `ready`, and no edge reaches `proposing` from the develop/review loop
  // or from the budget gate.
  for (const chart of [reviewedEndoReleaseChart, reviewedNixosChangeChart]) {
    const graph = renderGraph(chart);

    const inbound = graph.edges.filter(
      edge => edge.to === 'proposing' && edge.from !== edge.to,
    );
    t.deepEqual(
      [...new Set(inbound.map(edge => edge.from))].sort(),
      ['preview', 'ready'],
      `${chart.name} proposing is reached only from the post-review states`,
    );

    // `ready` — the head of that chain — is entered from another state only by
    // the panel's unanimous approval. Its internal budget assignment preserves
    // the immutable pending policy emit and does not add an inbound edge.
    const intoReady = graph.edges.filter(
      edge => edge.to === 'ready' && edge.from !== 'ready',
    );
    t.is(intoReady.length, 1, `${chart.name} ready inbound edges`);
    t.is(intoReady[0].from, 'review');
    t.is(intoReady[0].type, 'regions-settled');
    t.true(intoReady[0].guarded, 'only the unanimous-approval guard admits it');

    // And `preview` is entered from another state only from `ready`; its
    // internal budget assignment preserves the pending CI effect.
    const intoPreview = graph.edges.filter(
      edge => edge.to === 'preview' && edge.from !== 'preview',
    );
    t.is(intoPreview.length, 1, `${chart.name} preview inbound edges`);
    t.is(intoPreview[0].from, 'ready');

    // Nothing in the loop reaches the proposal directly.
    for (const edge of inbound) {
      t.not(edge.from, 'implement');
      t.not(edge.from, 'review');
      t.not(edge.from, 'gate');
      t.not(edge.from, 'exhausted');
    }
  }
});

test('the gated endo-release chart spawns its deploy with the reviewed head', t => {
  const sim = makeSimulator(reviewedEndoReleaseChart, { params });
  submitHead(sim);
  verdict(sim, true, 'lgtm');

  t.is(sim.status().state, 'proposing');
  const spawned = pendingOf(sim, 'spawn');
  t.is(spawned.effect.chart.name, 'endo-release');
  t.is(spawned.effect.params.rev, HEAD);
  t.deepEqual(spawned.effect.endowments, ['performer', 'operator']);

  sim.settle(
    spawned.effectId,
    'fulfilled',
    harden({ status: 'completed', output: { status: 'landed', rev: HEAD } }),
  );
  t.true(sim.status().done);
  t.deepEqual(sim.status().output, { head: HEAD, round: 0n });
});

test('a completed but non-landed deploy cannot report the review as landed', t => {
  const sim = makeSimulator(reviewedEndoReleaseChart, { params });
  submitHead(sim);
  verdict(sim, true, 'lgtm');

  const spawned = pendingOf(sim, 'spawn');
  sim.settle(
    spawned.effectId,
    'fulfilled',
    harden({
      status: 'completed',
      output: { status: 'abandoned', reason: 'declined' },
    }),
  );

  t.true(sim.status().done);
  t.is(sim.status().state, 'deploy-unsettled');
  t.deepEqual(sim.status().output, {
    head: HEAD,
    reason: {
      status: 'completed',
      output: { status: 'abandoned', reason: 'declined' },
    },
  });
});

test('the gated nixos chart requires staged files before the panel sees them', t => {
  const sim = makeSimulator(reviewedNixosChangeChart, { params });

  // A head alone does not describe a NixOS change; it costs a round rather
  // than reaching a spawn the deploy chart's params would reject.
  const ask = pendingOf(sim, 'ask', { to: 'developer' });
  sim.settle(ask.effectId, 'fulfilled', harden({ head: HEAD }));
  t.is(sim.status().state, 'implement');
  t.is(sim.status().context.remaining, 1n);

  const files = harden([{ path: 'modules/firewall.nix', text: '{ }\n' }]);
  const retry = pendingOf(sim, 'ask', { to: 'developer' });
  sim.settle(retry.effectId, 'fulfilled', harden({ head: HEAD, files }));
  t.is(sim.status().state, 'review');

  // The panel is shown the staged files, not just a ref.
  const [seat] = reviewerAsks(sim);
  t.true(seat.effect.what.description.includes('firewall.nix'));

  verdict(sim, true, 'lgtm');
  const spawned = pendingOf(sim, 'spawn');
  t.is(spawned.effect.chart.name, 'nixos-config-change');
  t.deepEqual(spawned.effect.params.files, files);
});
