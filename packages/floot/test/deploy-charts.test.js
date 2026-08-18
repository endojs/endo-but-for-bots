// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { chartDiagnostics } from '@endo/workflow/machine.js';
import { makeSimulator } from '@endo/workflow/src/simulate.js';
import { renderGraph } from '@endo/workflow/src/graph.js';

import {
  deployCharts,
  endoReleaseChart,
  nixosConfigChangeChart,
} from '../deploy-charts.js';

const REV = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';
const PREVIOUS = '59aba752de8ebbbcb485015e9159dcb6d16856e6';

const releaseParams = harden({
  title: 'fix(floot): raise the tool-step ceiling',
  summary: 'One-line change to the agent loop; tests pass.',
  rev: REV,
});

const changeParams = harden({
  title: 'nix: open the metrics port',
  summary: 'Adds one firewall rule.',
  files: [{ path: 'modules/firewall.nix', text: '{ }\n' }],
});

const pendingOf = (sim, kind, method) =>
  sim
    .pending()
    .find(
      record =>
        record.effect.kind === kind &&
        (method === undefined || record.effect.method === method),
    );

test('both deploy charts pass diagnostics with no errors or warnings', t => {
  for (const chart of deployCharts) {
    const { errors, warnings } = chartDiagnostics(chart);
    t.deepEqual(errors, [], `${chart.name} errors`);
    t.deepEqual(warnings, [], `${chart.name} warnings`);
  }
});

test('apply is entered exactly once, only by operator approval', t => {
  // The restart-loop guard at the chart level: no failure, timeout, or
  // resume path may lead back to `apply`. Its ONLY inbound edge is the
  // approval transition, so a run can attempt at most one apply, ever;
  // trying again is a new run through a new approval.
  for (const chart of deployCharts) {
    const graph = renderGraph(chart);
    const inbound = graph.edges.filter(edge => edge.to === 'apply');
    t.is(inbound.length, 1, `${chart.name} apply inbound edges`);
    t.is(inbound[0].from, 'await-approval');
    t.is(inbound[0].type, 'operator-decided');
    t.true(inbound[0].guarded, 'only the approval guard admits an apply');
  }
});

test('endo-release walks pin, build, approval, apply, verify to done', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });

  t.is(sim.status().state, 'pin');
  const pin = pendingOf(sim, 'invoke', 'stageRev');
  // Entry substitution already resolved the template: the performer will
  // receive the actual revision.
  t.deepEqual(pin.effect.args, [REV]);
  sim.settle(pin.effectId, 'fulfilled', harden({ rev: REV, previous: PREVIOUS }));

  t.is(sim.status().state, 'build');
  const build = pendingOf(sim, 'invoke', 'build');
  sim.settle(build.effectId, 'fulfilled', harden({ ok: true, phase: 'ok' }));

  t.is(sim.status().state, 'await-approval');
  const ask = pendingOf(sim, 'ask');
  // Delimited interpolation: participant-supplied strings render quoted.
  t.regex(ask.effect.form.description, /Deploy Endo "f83f0430/);
  sim.settle(ask.effectId, 'fulfilled', harden({ approved: true, note: '' }));

  t.is(sim.status().state, 'apply');
  const apply = pendingOf(sim, 'invoke', 'apply');
  sim.settle(apply.effectId, 'fulfilled', harden({ ok: true, phase: 'ok' }));

  t.is(sim.status().state, 'verify');
  const verify = pendingOf(sim, 'invoke', 'verify');
  const done = sim.settle(
    verify.effectId,
    'fulfilled',
    harden({ ok: true, runningRev: REV }),
  );
  t.true(done.done);
  t.is(done.outcome, 'completed');
  t.deepEqual(done.output, { rev: REV });
});

test('a declined release unpins the previous revision and abandons', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ approved: false, note: 'not today' }),
  );

  t.is(sim.status().state, 'unpinning');
  const unpin = pendingOf(sim, 'invoke', 'stageRev');
  // Compensation restages what pin captured — the substituted args carry
  // the journaled previous revision, not a fresh guess.
  const final = sim.settle(
    unpin.effectId,
    'fulfilled',
    harden({ rev: PREVIOUS, previous: REV }),
  );
  t.true(final.done);
  t.deepEqual(final.output, { reason: 'declined' });
});

test('a rejected build unpins without ever reaching approval', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: false, phase: 'error', log: 'evaluation failed' }),
  );
  t.is(sim.status().state, 'unpinning');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: PREVIOUS, previous: REV }),
  );
  t.deepEqual(final.output, { reason: 'build-rejected' });
});

test('a build timeout prunes the pending invoke on its way out', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  const build = pendingOf(sim, 'invoke', 'build');
  const timer = pendingOf(sim, 'after');
  const timed = sim.fireTimer(timer.effectId);
  t.is(timed.state, 'unpinning');
  // The exited state's invoke left pending with it: a late build
  // settlement has nothing to land on (the live engine drops it), so it
  // cannot steer the run after the timeout routed it to compensation.
  t.is(
    sim.pending().find(record => record.effectId === build.effectId),
    undefined,
  );
});

test('an unhealthy apply reports the auto-rollback and terminates', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  const report = harden({
    ok: false,
    phase: 'error',
    log: 'health check failed; rolled back to generation 41',
  });
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'apply').effectId,
    'fulfilled',
    report,
  );
  t.true(final.done);
  t.deepEqual(final.output, { report });
});

test('an apply error goes to the operator, and resume re-verifies', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'apply').effectId,
    'failed',
    'applier unreachable',
  );

  t.is(sim.status().state, 'needs-attention');
  sim.settle(pendingOf(sim, 'ask').effectId, 'fulfilled', 'looking into it');

  t.is(sim.status().state, 'verify');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'verify').effectId,
    'fulfilled',
    harden({ ok: true, runningRev: REV }),
  );
  t.true(final.done);
  t.is(final.outcome, 'completed');
});

test('nixos-config-change stages, gets approval, applies to done', t => {
  const sim = makeSimulator(nixosConfigChangeChart, { params: changeParams });

  t.is(sim.status().state, 'stage');
  const stage = pendingOf(sim, 'invoke', 'stageFiles');
  t.deepEqual(stage.effect.args, [changeParams.files]);
  sim.settle(
    stage.effectId,
    'fulfilled',
    harden({
      paths: ['modules/firewall.nix'],
      previous: [{ path: 'modules/firewall.nix', text: null }],
    }),
  );

  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );

  t.is(sim.status().state, 'await-approval');
  const ask = pendingOf(sim, 'ask');
  // The operator sees the touched paths, journaled at stage time.
  t.regex(ask.effect.form.description, /modules\/firewall\.nix/);

  sim.settle(ask.effectId, 'fulfilled', harden({ approved: true, note: '' }));
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'apply').effectId,
    'fulfilled',
    harden({ ok: true, phase: 'ok' }),
  );
  t.true(final.done);
  t.is(final.outcome, 'completed');
});

test('a declined nixos change reverts the captured previous contents', t => {
  const sim = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  const previous = harden([{ path: 'modules/firewall.nix', text: null }]);
  sim.settle(
    pendingOf(sim, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'], previous }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ approved: false, note: '' }),
  );

  t.is(sim.status().state, 'reverting');
  const revert = pendingOf(sim, 'invoke', 'revertFiles');
  // The compensation's args carry the journaled previous contents.
  t.deepEqual(revert.effect.args, [previous]);
  const final = sim.settle(
    revert.effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'] }),
  );
  t.true(final.done);
  t.deepEqual(final.output, { reason: 'declined' });
});

test('a nixos-change apply failure resumes through the status probe', t => {
  const sim = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'], previous: [] }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  sim.settle(
    pendingOf(sim, 'invoke', 'apply').effectId,
    'failed',
    'spool unreachable',
  );

  t.is(sim.status().state, 'needs-attention');
  sim.settle(pendingOf(sim, 'ask').effectId, 'fulfilled', 'checking');

  t.is(sim.status().state, 'probe');
  // An inconclusive probe returns to the operator rather than guessing.
  sim.settle(
    pendingOf(sim, 'invoke', 'status').effectId,
    'fulfilled',
    harden({ config: {}, status: null }),
  );
  t.is(sim.status().state, 'needs-attention');

  sim.settle(pendingOf(sim, 'ask').effectId, 'fulfilled', 'fixed it');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'status').effectId,
    'fulfilled',
    harden({ config: {}, status: { id: 'x', phase: 'ok' } }),
  );
  t.true(final.done);
  t.is(final.outcome, 'completed');
});
