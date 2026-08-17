// @ts-check

/**
 * The design's motivating use case, end to end over the fake daemon: an
 * implementer agent is asked to implement a feature; two specialist
 * reviewers review in parallel regions; changes requested loop the
 * feedback back to the implementer; unanimous approval runs CI; the
 * daemon restarts in the middle of the CI invoke and recovery
 * re-dispatches it under the same idempotency key; a passing CI prompts
 * the operator with a form; approval lands the merge. The journal is the
 * attributed audit log of the whole story.
 */
import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { M } from '@endo/patterns';
import { makeWorkflowService } from '../src/service.js';
import { makeFakeAgent, makeFakeClock } from './fake-agent.js';

const makeIdCounter = prefix => {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
};

const until = async (fn, label = 'condition', tries = 600) => {
  await null;
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await null;
  }
  throw Error(`timed out waiting for ${label}`);
};

const reviewerVerdict = harden({
  name: 'reviewer-verdict',
  version: 1,
  initial: 'deciding',
  states: {
    deciding: {
      entry: [
        {
          kind: 'ask',
          to: { $params: 'item' },
          what: {
            description: 'Review {$params.title} at {$params.head}',
          },
          outcome: 'verdict',
        },
      ],
      on: {
        verdict: [
          {
            when: M.splitRecord({
              value: M.splitRecord({ approve: M.eq(true) }),
            }),
            target: 'approved',
            assign: { feedback: { $event: 'value.feedback' } },
          },
          {
            target: 'changesRequested',
            assign: { feedback: { $event: 'value.feedback' } },
          },
        ],
      },
    },
    approved: { final: true, output: { feedback: { $ctx: 'feedback' } } },
    changesRequested: {
      final: true,
      output: { feedback: { $ctx: 'feedback' } },
    },
  },
});

const featureChange = harden({
  name: 'feature-change',
  version: 1,
  params: M.splitRecord({
    title: M.string(),
    reviewers: M.arrayOf(M.string()),
  }),
  context: { round: 0, feedback: [] },
  initial: 'implement',
  states: {
    implement: {
      entry: [
        {
          kind: 'ask',
          to: 'implementer',
          what: {
            description:
              'Implement {$params.title} (round {$ctx.round}). Prior feedback: {$ctx.feedback}',
          },
          outcome: 'submitted',
        },
      ],
      on: {
        submitted: [
          { target: 'review', assign: { head: { $event: 'value' } } },
        ],
      },
    },
    review: {
      regions: {
        $eachParam: 'reviewers',
        chart: reviewerVerdict,
        input: { title: { $params: 'title' }, head: { $ctx: 'head' } },
      },
      join: 'counts',
      on: {
        'regions-settled': [
          {
            when: M.splitRecord({
              counts: M.splitRecord({ changesRequested: M.gte(1) }),
            }),
            target: 'implement',
            assign: {
              round: { $inc: 1 },
              feedback: { $event: 'outcomes' },
            },
          },
          {
            when: M.splitRecord({
              counts: M.splitRecord({ approved: M.gte(2), pending: M.eq(0) }),
            }),
            target: 'ci',
          },
        ],
      },
    },
    ci: {
      entry: [
        {
          kind: 'invoke',
          target: 'ci',
          method: 'perform',
          args: [{ $ctx: 'head' }],
          outcome: 'ci-result',
        },
        { kind: 'after', ms: 3_600_000, emit: { type: 'ci-timed-out' } },
      ],
      on: {
        'ci-result': [
          {
            when: M.splitRecord({ value: M.splitRecord({ ok: M.eq(true) }) }),
            target: 'await-approval',
          },
          {
            target: 'implement',
            assign: { round: { $inc: 1 }, feedback: { $event: 'value' } },
          },
        ],
        'ci-timed-out': [{ target: 'abandoned' }],
      },
    },
    'await-approval': {
      entry: [
        {
          kind: 'ask',
          to: 'operator',
          form: {
            description:
              'Merge {$params.title} ({$ctx.head}) after round {$ctx.round}?',
            fields: [
              {
                name: 'approved',
                label: 'Merge this change?',
                pattern: M.boolean(),
              },
            ],
          },
          outcome: 'operator-decided',
        },
      ],
      on: {
        'operator-decided': [
          {
            when: M.splitRecord({
              value: M.splitRecord({ approved: M.eq(true) }),
            }),
            target: 'merge',
          },
          { target: 'abandoned' },
        ],
      },
    },
    merge: {
      entry: [
        {
          kind: 'invoke',
          target: 'merger',
          method: 'perform',
          args: [{ $ctx: 'head' }],
          outcome: 'landed',
        },
      ],
      on: { landed: [{ target: 'done' }] },
    },
    done: { final: true, output: { head: { $ctx: 'head' } } },
    abandoned: { final: true },
  },
});

test('the feature-change loop survives review rounds and a mid-CI restart', async t => {
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({
    powers,
    clock,
    makeId: makeIdCounter('a'),
  });

  // CI: incarnation one hangs (the daemon will die mid-check);
  // incarnation two answers green. The merger records the landed ref.
  const ciCalls = [];
  let ciResponds = false;
  const ci = Far('CI', {
    perform: async (ref, effectId) => {
      ciCalls.push({ ref, effectId });
      if (!ciResponds) {
        return new Promise(() => {});
      }
      return harden({ ok: true, log: `checked ${ref}` });
    },
  });
  const landed = [];
  const merger = Far('Merger', {
    perform: async (ref, _effectId) => {
      landed.push(ref);
      return harden({ merged: ref });
    },
  });

  const marker = needle => controls.findMessage('request', needle);
  const { runId } = await E(h1.service).start(featureChange, {
    params: harden({ title: 'adder', reviewers: ['alice', 'bob'] }),
    endowments: harden({
      implementer: harden({}),
      alice: harden({}),
      bob: harden({}),
      ci,
      merger,
      operator: harden({}),
    }),
  });
  const engine1 = h1.engines.get(runId);

  // Round 0: the implementer is asked and submits a head ref.
  await until(
    () => marker('Implement adder (round 0)') !== undefined,
    'implementer asked',
  );
  await controls.resolveRequest(marker('Implement adder (round 0)'), 'sha-1');

  // Both reviewers are asked about sha-1, in parallel.
  await until(
    () => controls.messageCount('request', 'Review adder at sha-1') === 2,
    'reviewers asked',
  );
  // One reviewer requests changes — decisive on its own — and the other
  // approves; the run loops back with the feedback in context. (The
  // duplicate resolution of the already-settled request is a no-op, as
  // in the daemon.)
  await controls.resolveRequest(
    marker('Review adder at sha-1'),
    harden({ approve: false, feedback: 'needs tests' }),
  );
  for (const message of (await E(powers).listMessages()).filter(m =>
    m.description?.includes('Review adder at sha-1'),
  )) {
    // eslint-disable-next-line no-await-in-loop
    await controls.resolveRequest(
      message,
      harden({ approve: true, feedback: 'lgtm' }),
    );
  }
  await until(
    () => marker('Implement adder (round 1)') !== undefined,
    'round-1 implementer ask',
  );
  const round1 = marker('Implement adder (round 1)');
  t.true(round1.description.includes('needs tests'));
  t.is(engine1.fold.context.round, 1);

  // Round 1: submit sha-2; both reviewers approve; CI starts and hangs.
  await controls.resolveRequest(round1, 'sha-2');
  await until(
    () => controls.messageCount('request', 'Review adder at sha-2') === 2,
    'round-1 reviewers asked',
  );
  for (const message of (await E(powers).listMessages()).filter(m =>
    m.description?.includes('Review adder at sha-2'),
  )) {
    // eslint-disable-next-line no-await-in-loop
    await controls.resolveRequest(
      message,
      harden({ approve: true, feedback: 'ok' }),
    );
  }
  await until(() => ciCalls.length === 1, 'CI dispatched');
  t.is(ciCalls[0].ref, 'sha-2');
  t.is(engine1.fold.configuration.state, 'ci');

  // The daemon dies mid-CI and comes back.
  h1.stop();
  ciResponds = true;
  const h2 = await makeWorkflowService({
    powers: controls.restart(),
    clock,
    makeId: makeIdCounter('b'),
  });
  const engine = h2.engines.get(runId);
  t.is(engine.fold.configuration.state, 'ci');

  // Recovery re-dispatches the CI invoke under the same effectId.
  await until(() => ciCalls.length === 2, 'CI re-dispatched');
  t.is(ciCalls[0].effectId, ciCalls[1].effectId);

  // Green CI prompts the operator; approval lands the merge.
  await until(
    () => controls.findMessage('form', 'Merge adder (sha-2)') !== undefined,
    'operator prompted',
  );
  await controls.submitForm(
    controls.findMessage('form', 'Merge adder (sha-2)'),
    { approved: true },
  );
  await until(() => engine.fold.done, 'run completion');
  t.is(engine.fold.outcome, 'completed');
  t.deepEqual(engine.fold.output, { head: 'sha-2' });
  t.deepEqual(landed, ['sha-2']);
  // Exiting `ci` pruned its timeout; nothing is left pending.
  t.is(engine.fold.pending.size, 0);

  // Ask economy: two implementer rounds, two reviews per reviewer round,
  // one operator form. Nothing was double-sent across the restart.
  t.is(controls.messageCount('request', 'Implement adder'), 2);
  t.is(controls.messageCount('request', 'Review adder'), 4);
  t.is(controls.messageCount('form', 'Merge adder'), 1);

  // The journal is the attributed audit log: asks, invokes, and the
  // operator's decision are all traceable to structural senders.
  const journal = await E(engine.runFacet).journal();
  const bys = new Set(journal.map(entry => entry.by));
  t.true(bys.has('ask:implementer'));
  t.true(bys.has('ask:alice'));
  t.true(bys.has('ask:bob'));
  t.true(bys.has('invoke:ci'));
  t.true(bys.has('ask:operator'));
  t.true(bys.has('invoke:merger'));
  // The full fold of the stored journal agrees with the live engine.
  t.is(engine.fold.nextSeq, BigInt(journal.length));
  t.pass();
});
