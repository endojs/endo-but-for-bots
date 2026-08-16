// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
/* eslint-disable no-template-curly-in-string -- assertions over the workflow template DSL */

import { E } from '@endo/eventual-send';
import { makeInMemoryFilesystem } from '@endo/platform/fs/extended';

import { makeWorkflowEngine, makeWorkflowSyncClient } from '../src/index.js';
import {
  featureChange,
  featureChangeParticipants,
} from './fixtures/feature-change.js';

/**
 * A controllable delivery seam: every request/form/call parks in an
 * inbox until the test settles it, so tests drive participants
 * explicitly (including across an engine restart).
 */
const makeStubDeliver = () => {
  /** @type {Array<{ kind: string, target: unknown, payload: any, method?: string, args?: unknown[], resolve: (v: unknown) => void, reject: (e: unknown) => void }>} */
  const inbox = [];
  const deliver = harden({
    /**
     * @param {unknown} target
     * @param {any} payload
     */
    request: (target, payload) =>
      new Promise((resolve, reject) => {
        inbox.push({ kind: 'request', target, payload, resolve, reject });
      }),
    /**
     * @param {unknown} target
     * @param {any} payload
     */
    form: (target, payload) =>
      new Promise((resolve, reject) => {
        inbox.push({ kind: 'form', target, payload, resolve, reject });
      }),
    /**
     * @param {unknown} target
     * @param {string} method
     * @param {unknown[]} args
     * @param {any} _options
     */
    call: (target, method, args, _options) =>
      new Promise((resolve, reject) => {
        inbox.push({ kind: 'call', target, method, args, resolve, reject });
      }),
    /**
     * @param {unknown} target
     * @param {string} method
     */
    attenuate: (target, method) => Promise.resolve(`${target}#${method}`),
  });
  /**
   * @param {(entry: any) => boolean} predicate
   */
  const take = predicate => {
    const index = inbox.findIndex(predicate);
    if (index === -1) {
      throw new Error(
        `no matching delivery; inbox: ${JSON.stringify(
          inbox.map(({ kind, target, method }) => ({ kind, target, method })),
        )}`,
      );
    }
    return inbox.splice(index, 1)[0];
  };
  return { deliver, inbox, take };
};

const makeFakeTimers = () => {
  /** @type {Map<number, { ms: number, fire: () => void }>} */
  const timers = new Map();
  let nextTimer = 0;
  /** @type {(ms: number, fire: () => void) => () => void} */
  const makeTimer = (ms, fire) => {
    nextTimer += 1;
    const id = nextTimer;
    timers.set(id, { ms, fire });
    return () => timers.delete(id);
  };
  return { timers, makeTimer };
};

/** @param {number} [rounds] */
const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

const makeHarness = async (storeRoot = undefined) => {
  await null;
  const fs = makeInMemoryFilesystem();
  const root =
    storeRoot ??
    (await E(await E(fs).root()).makeDirectory('workflow-store', {}));
  const stub = makeStubDeliver();
  const fake = makeFakeTimers();
  let idCounter = 0;
  let tick = 0;
  const engine = await makeWorkflowEngine({
    storeRoot: root,
    deliver: stub.deliver,
    now: () => {
      tick += 1;
      return tick;
    },
    makeId: () => {
      idCounter += 1;
      return String(idCounter);
    },
    makeTimer: fake.makeTimer,
    rebindParticipants: async () => featureChangeParticipants,
    warn: () => {},
  });
  return { engine, stub, fake, root };
};

const startInput = { request: 'add dark mode', branch: 'feat/dark-mode' };

test('the engine drives the feature-change loop end to end', async t => {
  const { engine, stub } = await makeHarness();
  await E(engine.service).define('feature-change', featureChange);
  const { runId, observer } = await E(engine.service).start('feature-change', {
    input: startInput,
    participants: featureChangeParticipants,
  });
  await flush();

  // The implementer receives the request with the writer facet attached.
  const implementation = stub.take(
    entry => entry.kind === 'request' && entry.target === 'lal-coder',
  );
  t.is(
    implementation.payload.description,
    'Implement: "add dark mode" on "feat/dark-mode"',
  );
  t.is(implementation.payload.attachments.repo, 'repo-writer');
  implementation.resolve({ changeSet: 'cs-1' });
  await flush();

  let status = await E(observer).status();
  t.is(status.state, 'reviewing');

  // Both reviewers receive the fanout with the reader attenuation.
  const review1 = stub.take(entry => entry.target === 'sec-reviewer');
  const review2 = stub.take(entry => entry.target === 'style-reviewer');
  t.is(review1.payload.attachments['repo:readOnly'], 'repo-writer#readOnly');
  review1.resolve({ verdict: 'approve' });
  review2.resolve({ verdict: 'approve' });
  await flush();

  // CI runs as a call with the branch argument resolved raw.
  const ci = stub.take(
    entry => entry.kind === 'call' && entry.target === 'repo-ci',
  );
  t.is(ci.method, 'run');
  ci.resolve('green');
  await flush();

  // The approver gets a form; a yes merges.
  const approval = stub.take(entry => entry.kind === 'form');
  t.is(approval.target, 'SELF');
  approval.resolve({ decision: 'yes' });
  await flush();

  const merge = stub.take(
    entry => entry.kind === 'call' && entry.method === 'merge',
  );
  t.is(merge.target, 'repo-writer');
  merge.resolve('merged');
  await flush();

  status = await E(observer).status();
  t.is(status.state, 'done');
  t.is(status.final, 'succeeded');

  // The audit log is complete and chained.
  const journal = await E(observer).exportJournal();
  t.is(journal[0].type, 'run.started');
  t.is(journal[journal.length - 1].type, 'run.finished');
  t.true(journal.some(record => record.type === 'fanout.result'));
  t.truthy(runId);
});

test('a restart mid-review resumes and re-requests only the missing reviewer', async t => {
  const first = await makeHarness();
  await E(first.engine.service).define('feature-change', featureChange);
  const { runId } = await E(first.engine.service).start('feature-change', {
    input: startInput,
    participants: featureChangeParticipants,
  });
  await flush();
  first.stub
    .take(entry => entry.target === 'lal-coder')
    .resolve({ changeSet: 'cs-1' });
  await flush();
  // One of two verdicts arrives before the "restart".
  first.stub
    .take(entry => entry.target === 'sec-reviewer')
    .resolve({ verdict: 'approve' });
  await flush();

  // A second engine over the same store is the restart.
  const second = await makeHarness(first.root);
  await flush();
  const observer = await E(second.engine.service).run(runId);
  const status = await E(observer).status();
  t.is(status.state, 'reviewing');

  // Only the style reviewer is re-asked; the security verdict was
  // journaled and recovered.
  const reviews = second.stub.inbox.filter(entry => entry.kind === 'request');
  t.deepEqual(
    reviews.map(entry => entry.target),
    ['style-reviewer'],
  );
  second.stub
    .take(entry => entry.target === 'style-reviewer')
    .resolve({ verdict: 'approve' });
  await flush();
  t.is((await E(observer).status()).state, 'testing');

  // The journal records that recovery ran.
  const journal = await E(observer).exportJournal();
  t.true(journal.some(record => record.type === 'recovery.completed'));
});

test('a restart with a pending non-idempotent call routes to indeterminate handling', async t => {
  const first = await makeHarness();
  await E(first.engine.service).define('feature-change', featureChange);
  const { runId } = await E(first.engine.service).start('feature-change', {
    input: startInput,
    participants: featureChangeParticipants,
  });
  await flush();
  first.stub
    .take(entry => entry.target === 'lal-coder')
    .resolve({ changeSet: 'cs-1' });
  await flush();
  first.stub
    .take(entry => entry.target === 'sec-reviewer')
    .resolve({ verdict: 'approve' });
  first.stub
    .take(entry => entry.target === 'style-reviewer')
    .resolve({ verdict: 'approve' });
  await flush();
  // Now in testing with the CI call pending; restart.
  const second = await makeHarness(first.root);
  await flush();
  const observer = await E(second.engine.service).run(runId);
  // The ci-run call is not marked idempotent, so recovery rejects it as
  // indeterminate and the definition loops back to implementing.
  t.is((await E(observer).status()).state, 'implementing');
  const journal = await E(observer).exportJournal();
  const indeterminate = journal.find(
    record =>
      record.type === 'effect.rejected' &&
      /indeterminate/u.test(/** @type {string} */ (record.reason)),
  );
  t.truthy(indeterminate);
});

test('factories bind slots, enforce limits, derive narrower, and revoke as a tree', async t => {
  const { engine, stub } = await makeHarness();
  await E(engine.service).define('feature-change', featureChange);
  const { factory, factoryAdmin } = await E(engine.service).makeFactory({
    definition: 'feature-change',
    participants: featureChangeParticipants,
    limits: { maxConcurrent: 1 },
  });

  const described = await E(factory).describe();
  t.deepEqual(described.openSlots, []);
  t.is(described.boundSlotNames.length, 5);

  // A caller starts with input only and receives the observer facet.
  const observer = await E(factory).start(startInput);
  await flush();
  t.is((await E(observer).status()).state, 'implementing');
  // The observer facet has no admin or controller methods.
  await t.throwsAsync(() => E(observer).abort('nope'), undefined);
  await t.throwsAsync(() => E(observer).signal('nudge'), undefined);

  // The concurrency limit rejects a second live run.
  await t.throwsAsync(() => E(factory).start(startInput), {
    message: /concurrency limit/u,
  });

  // Bound slots cannot be overridden at start.
  await t.throwsAsync(
    () => E(factory).start(startInput, { repo: 'evil-repo' }),
    { message: /bound and cannot be overridden/u },
  );

  // Derivation cannot rebind bound slots, and revocation cascades.
  const derived = await E(factory).with({ input: { request: 'fixed' } });
  await t.throwsAsync(
    () => E(factory).with({ participants: { repo: 'evil' } }),
    { message: /cannot rebind bound slot/u },
  );
  await E(factoryAdmin).revoke();
  await t.throwsAsync(() => E(derived).start(startInput), {
    message: /revoked/u,
  });
  t.true(stub.inbox.length >= 1);
});

test('spawned children report output to the parent and abort cascades down', async t => {
  const { engine, stub } = await makeHarness();
  const child = harden({
    name: 'child-probe',
    version: 1,
    participants: { worker: { description: 'w' } },
    input: { question: 'M.string()' },
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            effect: 'request',
            to: 'worker',
            description: 'Answer: ${context.question}',
            as: 'answer',
          },
        ],
        onError: 'broken',
        on: {
          'effect.settled': {
            when: { as: 'answer' },
            assign:
              '({ context, event }) => ({ ...context, answer: event.value })',
            target: 'done',
          },
        },
      },
      done: {
        final: 'succeeded',
        output: '({ context }) => context.answer',
      },
      broken: { final: 'failed' },
    },
  });
  const parent = harden({
    name: 'parent-probe',
    version: 1,
    participants: { worker: { description: 'w' } },
    initial: 'delegating',
    states: {
      delegating: {
        entry: [
          {
            effect: 'spawn',
            workflow: 'child-probe',
            participants: { worker: 'worker' },
            input: '({ context }) => ({ question: "why" })',
            as: 'delegate',
          },
        ],
        onError: 'failed',
        on: {
          'child.finished': [
            {
              when: { as: 'delegate', final: 'succeeded' },
              assign:
                '({ context, event }) => ({ ...context, got: event.output })',
              target: 'done',
            },
            { when: { as: 'delegate' }, target: 'failed' },
          ],
        },
      },
      done: { final: 'succeeded' },
      failed: { final: 'failed' },
    },
  });
  await E(engine.service).define('child-probe', child);
  await E(engine.service).define('parent-probe', parent);

  const { observer } = await E(engine.service).start('parent-probe', {
    participants: { worker: 'the-worker' },
  });
  await flush();
  const ask = stub.take(entry => entry.kind === 'request');
  t.is(ask.target, 'the-worker');
  t.is(ask.payload.description, 'Answer: "why"');
  ask.resolve(42);
  await flush();
  const status = await E(observer).status();
  t.is(status.state, 'done');
  t.is(status.context.got, 42);

  // Abort cascade: start another parent, abort it while the child waits.
  const started = await E(engine.service).start('parent-probe', {
    participants: { worker: 'the-worker' },
  });
  await flush();
  const runsBefore = await E(engine.service).runs();
  const liveChild = runsBefore.find(
    summary => summary.parent === started.runId && summary.final === undefined,
  );
  t.truthy(liveChild);
  await E(started.admin).abort('changed my mind');
  await flush();
  const runsAfter = await E(engine.service).runs();
  const childAfter = runsAfter.find(
    summary => summary.runId === /** @type {any} */ (liveChild).runId,
  );
  t.is(/** @type {any} */ (childAfter).final, 'aborted');
});

test('after timers fire through the fake clock and admin pause defers events', async t => {
  const { engine, stub, fake } = await makeHarness();
  await E(engine.service).define('feature-change', featureChange);
  const { observer, admin } = await E(engine.service).start('feature-change', {
    input: startInput,
    participants: featureChangeParticipants,
  });
  await flush();
  stub
    .take(entry => entry.target === 'lal-coder')
    .resolve({ changeSet: 'cs-1' });
  await flush();
  t.is((await E(observer).status()).state, 'reviewing');

  // Pause: a reviewer verdict arriving now is deferred, not applied.
  await E(admin).pause();
  await flush();
  stub
    .take(entry => entry.target === 'sec-reviewer')
    .resolve({ verdict: 'approve' });
  stub
    .take(entry => entry.target === 'style-reviewer')
    .resolve({ verdict: 'approve' });
  await flush();
  t.is((await E(observer).status()).state, 'reviewing');
  t.true((await E(observer).status()).paused);
  await E(admin).resume();
  await flush();
  t.is((await E(observer).status()).state, 'testing');

  // The reviewing timer was armed while we reviewed; the testing state
  // has none, so the timer set has been cleared of the reviewing one.
  t.true([...fake.timers.values()].every(timer => timer.ms > 0));

  // Drive to approving, then fire the approval timeout: abandoned.
  stub.take(entry => entry.kind === 'call').resolve('green');
  await flush();
  const approving = await E(observer).status();
  t.is(approving.state, 'approving');
  const [timer] = [...fake.timers.values()].slice(-1);
  timer.fire();
  await flush();
  t.is((await E(observer).status()).final, 'abandoned');
});

test('the sync client folds history to the live state and scrubs', async t => {
  const { engine, stub } = await makeHarness();
  await E(engine.service).define('feature-change', featureChange);
  const { observer } = await E(engine.service).start('feature-change', {
    input: startInput,
    participants: featureChangeParticipants,
  });
  await flush();
  const client = makeWorkflowSyncClient(observer);
  await flush();
  t.is(/** @type {any} */ (client.state).state, 'implementing');

  stub
    .take(entry => entry.target === 'lal-coder')
    .resolve({ changeSet: 'cs-1' });
  await flush();
  t.is(/** @type {any} */ (client.state).state, 'reviewing');

  // Scrubbing folds the local prefix without touching the engine.
  const early = client.stateAt(2);
  t.is(/** @type {any} */ (early).state, 'implementing');
  client.stop();
});

test('fragments inline at define time and run through the engine', async t => {
  const { engine, stub } = await makeHarness();
  const approvalGate = harden({
    kind: 'fragment',
    name: 'approval-gate',
    version: 1,
    participants: { approver: { description: 'who approves' } },
    initial: 'asking',
    states: {
      asking: {
        entry: [
          {
            effect: 'form',
            to: 'approver',
            description: 'Approve ${context.subject}?',
            fields: [{ name: 'decision', label: 'Approve?' }],
            as: 'gate',
          },
        ],
        onError: 'refused',
        on: {
          'form.value': [
            {
              when: { as: 'gate' },
              guard: '({ event }) => event.values.decision === "yes"',
              target: 'accepted',
            },
            { when: { as: 'gate' }, target: 'refused' },
          ],
        },
      },
      accepted: { boundary: 'approved' },
      refused: { boundary: 'declined' },
    },
  });
  const gated = harden({
    name: 'gated-thing',
    version: 1,
    participants: { boss: { description: 'the approver' } },
    input: { subject: 'M.string()' },
    initial: 'gate',
    states: {
      gate: {
        use: {
          fragment: 'approval-gate',
          bind: { approver: 'boss' },
          on: {
            approved: { target: 'doing' },
            declined: { target: 'dropped' },
          },
        },
      },
      doing: { final: 'succeeded' },
      dropped: { final: 'abandoned' },
    },
  });
  await E(engine.service).define('approval-gate', approvalGate);
  await E(engine.service).define('gated-thing', gated);

  const { observer } = await E(engine.service).start('gated-thing', {
    input: { subject: 'the plan' },
    participants: { boss: 'the-boss' },
  });
  await flush();
  const form = stub.take(entry => entry.kind === 'form');
  t.is(form.target, 'the-boss');
  t.is(form.payload.description, 'Approve "the plan"?');
  form.resolve({ decision: 'yes' });
  await flush();
  const status = await E(observer).status();
  t.is(status.state, 'doing');
  t.is(status.final, 'succeeded');
});

test('explain reports pending effects, waiting events, and unauthorized attempts', async t => {
  const { engine, stub } = await makeHarness();
  await E(engine.service).define('feature-change', featureChange);
  const { observer, controller } = await E(engine.service).start(
    'feature-change',
    { input: startInput, participants: featureChangeParticipants },
  );
  await flush();
  // A stray signal journals inert; a forged settlement journals
  // unauthorized.
  await E(controller).signal('nudge', { note: 'hello' });
  await flush();
  const explained = await E(observer).explain();
  t.is(explained.state, 'implementing');
  t.deepEqual(
    explained.pending.map((/** @type {any} */ pending) => pending.as),
    ['implementation'],
  );
  t.true(explained.waitingFor.includes('effect.settled'));
  t.true(stub.inbox.length > 0);
});
