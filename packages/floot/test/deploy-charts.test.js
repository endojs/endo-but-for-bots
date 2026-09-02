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

// The release chart (v2) builds the release BEFORE anyone is asked, so every
// walk through it passes a `prebuildRev` step between `pin` and `build`.
const settlePrebuild = (sim, outcome = harden({ ok: true, phase: 'ok' })) => {
  const prebuild = pendingOf(sim, 'invoke', 'prebuildRev');
  sim.settle(prebuild.effectId, 'fulfilled', outcome);
  return prebuild;
};

test('both deploy charts pass diagnostics with no errors or warnings', t => {
  for (const chart of deployCharts) {
    const { errors, warnings } = chartDiagnostics(chart);
    t.deepEqual(errors, [], `${chart.name} errors`);
    t.deepEqual(warnings, [], `${chart.name} warnings`);
  }
});

test('malformed successful staging stops before approval', t => {
  const release = makeSimulator(endoReleaseChart, { params: releaseParams });
  const releaseFinal = release.settle(
    pendingOf(release, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({}),
  );
  t.true(releaseFinal.done);
  t.is(releaseFinal.state, 'staging-unsettled');
  t.is(pendingOf(release, 'ask'), undefined);
  t.deepEqual(releaseFinal.output, {
    status: 'staging-unsettled',
    reason: 'stageRev returned without a valid revision and rollback ref',
  });

  const nixos = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  const nixosFinal = nixos.settle(
    pendingOf(nixos, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'] }),
  );
  t.true(nixosFinal.done);
  t.is(nixosFinal.state, 'staging-unsettled');
  t.is(pendingOf(nixos, 'ask'), undefined);
  t.deepEqual(nixosFinal.output, {
    status: 'staging-unsettled',
    reason: 'stageFiles returned without valid paths and rollback contents',
  });
});

test('silent staging stops truthfully and prunes the pending invoke', t => {
  /** @type {readonly { chart: any, params: Record<string, any>, method: string }[]} */
  const cases = harden([
    { chart: endoReleaseChart, params: releaseParams, method: 'stageRev' },
    {
      chart: nixosConfigChangeChart,
      params: changeParams,
      method: 'stageFiles',
    },
  ]);
  for (const { chart, params: chartParams, method } of cases) {
    const sim = makeSimulator(chart, { params: chartParams });
    const stage = pendingOf(sim, 'invoke', method);
    const timer = pendingOf(sim, 'after');
    const final = sim.fireTimer(timer.effectId);

    t.true(final.done);
    t.is(final.state, 'staging-unsettled');
    t.is(
      sim.pending().find(record => record.effectId === stage.effectId),
      undefined,
      `${chart.name} prunes the silent stage invoke`,
    );
    t.is(pendingOf(sim, 'ask'), undefined, 'no approval was raised');
  }
});

test('approval dispatch failures compensate staged changes', t => {
  const release = makeSimulator(endoReleaseChart, { params: releaseParams });
  release.settle(
    pendingOf(release, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(release);
  release.settle(
    pendingOf(release, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  release.settle(
    pendingOf(release, 'ask').effectId,
    'failed',
    'form dispatch failed',
  );
  t.is(release.status().state, 'unpinning');
  t.deepEqual(pendingOf(release, 'invoke', 'stageRev').effect.args, [PREVIOUS]);

  const nixos = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  const previous = harden([{ path: 'modules/firewall.nix', text: null }]);
  nixos.settle(
    pendingOf(nixos, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'], previous }),
  );
  nixos.settle(
    pendingOf(nixos, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  nixos.settle(
    pendingOf(nixos, 'ask').effectId,
    'failed',
    'form dispatch failed',
  );
  t.is(nixos.status().state, 'reverting');
  t.deepEqual(pendingOf(nixos, 'invoke', 'revertFiles').effect.args, [
    previous,
  ]);
});

test('silent verification and compensation route to attention', t => {
  const verifying = makeSimulator(endoReleaseChart, { params: releaseParams });
  verifying.settle(
    pendingOf(verifying, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(verifying);
  verifying.settle(
    pendingOf(verifying, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  verifying.settle(
    pendingOf(verifying, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  verifying.settle(
    pendingOf(verifying, 'invoke', 'apply').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  t.is(verifying.status().state, 'verify');
  verifying.fireTimer(pendingOf(verifying, 'after').effectId);
  t.is(verifying.status().state, 'needs-attention');

  const unpinning = makeSimulator(endoReleaseChart, { params: releaseParams });
  unpinning.settle(
    pendingOf(unpinning, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(unpinning, harden({ ok: false, phase: 'error' }));
  t.is(unpinning.status().state, 'unpinning');
  unpinning.fireTimer(pendingOf(unpinning, 'after').effectId);
  t.is(unpinning.status().state, 'compensation-attention');

  const reverting = makeSimulator(nixosConfigChangeChart, {
    params: changeParams,
  });
  reverting.settle(
    pendingOf(reverting, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({
      paths: ['modules/firewall.nix'],
      previous: [{ path: 'modules/firewall.nix', text: null }],
    }),
  );
  reverting.settle(
    pendingOf(reverting, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: false }),
  );
  t.is(reverting.status().state, 'reverting');
  reverting.fireTimer(pendingOf(reverting, 'after').effectId);
  t.is(reverting.status().state, 'compensation-attention');
});

test('malformed apply fulfillment requires operator attention', t => {
  const release = makeSimulator(endoReleaseChart, { params: releaseParams });
  release.settle(
    pendingOf(release, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(release);
  release.settle(
    pendingOf(release, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  release.settle(
    pendingOf(release, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  release.settle(
    pendingOf(release, 'invoke', 'apply').effectId,
    'fulfilled',
    harden({}),
  );
  t.is(release.status().state, 'needs-attention');
  t.truthy(pendingOf(release, 'ask'));

  const nixos = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  nixos.settle(
    pendingOf(nixos, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({
      paths: ['modules/firewall.nix'],
      previous: [{ path: 'modules/firewall.nix', text: null }],
    }),
  );
  nixos.settle(
    pendingOf(nixos, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: true }),
  );
  nixos.settle(
    pendingOf(nixos, 'ask').effectId,
    'fulfilled',
    harden({ approved: true, note: '' }),
  );
  nixos.settle(
    pendingOf(nixos, 'invoke', 'apply').effectId,
    'fulfilled',
    harden({ ok: 'yes' }),
  );
  t.is(nixos.status().state, 'needs-attention');
  t.truthy(pendingOf(nixos, 'ask'));
});

test('malformed compensation fulfillment cannot claim restoration', t => {
  const release = makeSimulator(endoReleaseChart, { params: releaseParams });
  release.settle(
    pendingOf(release, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(release, harden({ ok: false, phase: 'error' }));
  release.settle(
    pendingOf(release, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({}),
  );
  t.is(release.status().state, 'compensation-attention');
  t.false(release.status().done);

  const nixos = makeSimulator(nixosConfigChangeChart, { params: changeParams });
  nixos.settle(
    pendingOf(nixos, 'invoke', 'stageFiles').effectId,
    'fulfilled',
    harden({
      paths: ['modules/firewall.nix'],
      previous: [{ path: 'modules/firewall.nix', text: null }],
    }),
  );
  nixos.settle(
    pendingOf(nixos, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: false }),
  );
  nixos.settle(
    pendingOf(nixos, 'invoke', 'revertFiles').effectId,
    'fulfilled',
    harden({}),
  );
  t.is(nixos.status().state, 'compensation-attention');
  t.false(nixos.status().done);
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

test('compensation-attention cannot reach a landed terminal', t => {
  // The truthful-terminal guard: a failed compensation loops through a
  // human gate back to the compensation — it has no path to `done` or
  // `verify`, so an abandoned change cannot terminate as deployed.
  for (const chart of deployCharts) {
    const graph = renderGraph(chart);
    const exits = graph.edges.filter(
      edge => edge.from === 'compensation-attention',
    );
    t.is(exits.length, 2, `${chart.name} compensation-attention exits`);
    t.true(
      exits.every(edge =>
        ['unpinning', 'reverting', 'compensation-unsettled'].includes(edge.to),
      ),
      `${chart.name} compensation-attention cannot complete as landed`,
    );
  }
});

test('endo-release walks pin, prebuild, build, approval, apply, verify to done', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });

  t.is(sim.status().state, 'pin');
  const pin = pendingOf(sim, 'invoke', 'stageRev');
  // Entry substitution already resolved the template: the performer will
  // receive the actual revision.
  t.deepEqual(pin.effect.args, [REV]);
  sim.settle(
    pin.effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );

  t.is(sim.status().state, 'prebuild');
  const prebuild = pendingOf(sim, 'invoke', 'prebuildRev');
  // The release is built from the revision itself, before anyone is asked.
  t.deepEqual(prebuild.effect.args, [REV]);
  settlePrebuild(sim);

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
    harden({ ok: true, runningRev: REV, phase: 'ok' }),
  );
  t.true(done.done);
  t.is(done.outcome, 'completed');
  t.deepEqual(done.output, { status: 'landed', rev: REV });
});

test('a declined release unpins the previous revision and abandons', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
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
  t.deepEqual(final.output, { status: 'abandoned', reason: 'declined' });
});

test('a revision that does not build never reaches the operator', t => {
  // The point of prebuild: a broken revision costs an unpin, not an operator's
  // attention and not an apply. Nothing was activated, so compensation is the
  // same unpin a rejected config build takes.
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );

  t.is(sim.status().state, 'prebuild');
  settlePrebuild(sim, harden({ ok: false, phase: 'error', rev: REV }));

  t.is(sim.status().state, 'unpinning');
  t.is(
    pendingOf(sim, 'ask'),
    undefined,
    'no operator was asked to approve an unbuildable revision',
  );
  const unpin = pendingOf(sim, 'invoke', 'stageRev');
  t.deepEqual(unpin.effect.args, [PREVIOUS]);
});

test('a rejected build unpins without ever reaching approval', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
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
  t.deepEqual(final.output, {
    status: 'abandoned',
    reason: 'build-rejected',
  });
});

test('a build timeout prunes the pending invoke on its way out', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
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
  settlePrebuild(sim);
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
  t.deepEqual(final.output, { status: 'auto-rolled-back', report });
});

test('an apply error goes to the operator; attesting landed re-verifies', t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
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
  const attestation = pendingOf(sim, 'ask');
  t.regex(attestation.effect.form.description, /ended up applied/);
  sim.settle(
    attestation.effectId,
    'fulfilled',
    harden({ landed: true, note: 'it switched before the spool died' }),
  );

  // The operator's word alone does not complete the run: the pin readback
  // must also agree, with the applier settled.
  t.is(sim.status().state, 'verify');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'verify').effectId,
    'fulfilled',
    harden({ ok: true, runningRev: REV, phase: 'ok' }),
  );
  t.true(final.done);
  t.is(final.outcome, 'completed');
});

test('attesting not-landed abandons through compensation, never done', async t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
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
  sim.settle(
    pendingOf(sim, 'ask').effectId,
    'fulfilled',
    harden({ landed: false, note: 'nothing switched' }),
  );
  t.is(sim.status().state, 'unpinning');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: PREVIOUS, previous: REV }),
  );
  t.true(final.done);
  t.deepEqual(final.output, {
    status: 'abandoned',
    reason: 'operator-reported-not-landed',
  });
});

test('a first-pin decline un-pins to the empty previous and abandons', async t => {
  // The review blocker's worst case: on a host whose first-ever pin this
  // run staged, `previous` is '' — the compensation must be expressible
  // (stageRev('') removes the pin) so the decline path reaches
  // `abandoned` instead of wedging with the declined rev still staged.
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: '' }),
  );
  settlePrebuild(sim);
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
  t.is(sim.status().state, 'unpinning');
  const unpin = pendingOf(sim, 'invoke', 'stageRev');
  t.deepEqual(unpin.effect.args, ['']);
  const final = sim.settle(
    unpin.effectId,
    'fulfilled',
    harden({ rev: '', previous: REV }),
  );
  t.true(final.done);
  t.deepEqual(final.output, { status: 'abandoned', reason: 'declined' });
});

test('a failed un-pin loops through compensation-attention until it lands', async t => {
  const sim = makeSimulator(endoReleaseChart, { params: releaseParams });
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: REV, previous: PREVIOUS }),
  );
  settlePrebuild(sim);
  sim.settle(
    pendingOf(sim, 'invoke', 'build').effectId,
    'fulfilled',
    harden({ ok: false, phase: 'error' }),
  );
  t.is(sim.status().state, 'unpinning');
  sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'failed',
    'disk full',
  );
  t.is(sim.status().state, 'compensation-attention');
  sim.settle(pendingOf(sim, 'ask').effectId, 'fulfilled', 'retrying');
  t.is(sim.status().state, 'unpinning');
  const final = sim.settle(
    pendingOf(sim, 'invoke', 'stageRev').effectId,
    'fulfilled',
    harden({ rev: PREVIOUS, previous: REV }),
  );
  t.true(final.done);
  t.is(final.state, 'abandoned');
  t.deepEqual(final.output, {
    status: 'abandoned',
    reason: 'build-rejected',
  });
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
  t.deepEqual(final.output, { status: 'abandoned', reason: 'declined' });
});

test('a nixos-change apply failure resolves only by operator attestation', t => {
  const walkToApplyFailure = () => {
    const sim = makeSimulator(nixosConfigChangeChart, {
      params: changeParams,
    });
    sim.settle(
      pendingOf(sim, 'invoke', 'stageFiles').effectId,
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
    return sim;
  };

  // "It landed": the run completes on the operator's journaled word — the
  // config chart has no mechanical readback, and the applier's global
  // status phase was deliberately rejected as uncorrelated evidence.
  const landedSim = walkToApplyFailure();
  t.is(landedSim.status().state, 'needs-attention');
  const landedFinal = landedSim.settle(
    pendingOf(landedSim, 'ask').effectId,
    'fulfilled',
    harden({ landed: true, note: 'switched before the spool died' }),
  );
  t.true(landedFinal.done);
  t.is(landedFinal.outcome, 'completed');

  // "It did not land": abandon through compensation; a failed revert loops
  // through compensation-attention rather than completing.
  const lostSim = walkToApplyFailure();
  lostSim.settle(
    pendingOf(lostSim, 'ask').effectId,
    'fulfilled',
    harden({ landed: false, note: '' }),
  );
  t.is(lostSim.status().state, 'reverting');
  lostSim.settle(
    pendingOf(lostSim, 'invoke', 'revertFiles').effectId,
    'failed',
    'disk full',
  );
  t.is(lostSim.status().state, 'compensation-attention');
  lostSim.settle(pendingOf(lostSim, 'ask').effectId, 'fulfilled', 'retrying');
  t.is(lostSim.status().state, 'reverting');
  const lostFinal = lostSim.settle(
    pendingOf(lostSim, 'invoke', 'revertFiles').effectId,
    'fulfilled',
    harden({ paths: ['modules/firewall.nix'] }),
  );
  t.true(lostFinal.done);
  t.is(lostFinal.state, 'abandoned');
  t.deepEqual(lostFinal.output, {
    status: 'abandoned',
    reason: 'operator-reported-not-landed',
  });
});
