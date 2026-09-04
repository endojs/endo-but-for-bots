// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeTurnLedger } from '../src/turn-ledger.js';

/**
 * A persistence stub that records every write in order and can be made to
 * take time, so the tests can drive the windows the protocol has to survive.
 */
const makeStore = () => {
  /** @type {any[]} */
  const writes = [];
  /** @type {(() => void) | undefined} */
  let release;
  let gate;
  return {
    writes,
    persist: async record => {
      if (gate) await gate;
      writes.push(record === undefined ? null : { ...record });
    },
    /** Make the next persist wait until `open()` is called. */
    hold: () => {
      gate = new Promise(resolve => {
        release = () => resolve(undefined);
      });
    },
    open: () => {
      gate = undefined;
      if (release) release();
    },
    latest: () => writes[writes.length - 1],
  };
};

const makeAudit = () => {
  /** @type {string[]} */
  const events = [];
  return {
    events,
    audit: async (event, detail) => {
      events.push(`${event}:${JSON.stringify(detail)}`);
    },
  };
};

test('a turn is written ahead before it is dispatched', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  t.deepEqual(ledger.status(), {
    inFlight: false,
    needsReconciliation: false,
  });

  const turn = await ledger.begin({ baseCheckpoint: 'turn-1' });
  t.deepEqual(store.writes, [{ baseCheckpoint: 'turn-1', status: 'started' }]);
  t.like(ledger.status(), { inFlight: true, needsReconciliation: true });

  const settled = await turn.settle({
    type: 'completed',
    checkpoint: 'turn-2',
  });
  t.true(settled.accepted);
  t.deepEqual(store.latest(), {
    baseCheckpoint: 'turn-1',
    checkpoint: 'turn-2',
    status: 'completed',
  });
  t.like(ledger.status(), { inFlight: false, needsReconciliation: true });

  await ledger.acknowledge('turn-2');
  t.is(store.latest(), null);
  t.deepEqual(ledger.status(), {
    inFlight: false,
    needsReconciliation: false,
  });
});

test('a turn settles exactly once, and a late completion cannot rewrite it', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: null });

  const aborted = await turn.settle({ type: 'aborted', reason: 'interrupted' });
  t.true(aborted.accepted);

  // The provider's `completed` notification was already in flight when the
  // session was quarantined. It must not become the turn's outcome.
  const late = await turn.settle({ type: 'completed', checkpoint: 'turn-9' });
  t.false(late.accepted);
  t.deepEqual(late.outcome, { type: 'aborted', reason: 'interrupted' });
  t.deepEqual(store.writes, [{ baseCheckpoint: null, status: 'started' }]);
  t.like(ledger.status(), { needsReconciliation: true });
  t.deepEqual(ledger.getRecord(), { baseCheckpoint: null, status: 'started' });
});

test('a settlement racing a slow persist still loses', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: 'base' });

  // The durable write of the winning outcome is in progress — the exact window
  // in which a provider notification arrives and, before this ledger, took the
  // success branch.
  store.hold();
  const winner = turn.settle({ type: 'completed', checkpoint: 'turn-2' });
  const loser = await turn.settle({ type: 'aborted', reason: 'too late' });
  t.false(loser.accepted);
  t.deepEqual(loser.outcome, { type: 'completed', checkpoint: 'turn-2' });
  store.open();
  t.true((await winner).accepted);
  t.deepEqual(store.latest(), {
    baseCheckpoint: 'base',
    checkpoint: 'turn-2',
    status: 'completed',
  });
});

test('two turns cannot be in flight at once', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  await ledger.begin({ baseCheckpoint: null });
  await t.throwsAsync(ledger.begin({ baseCheckpoint: null }), {
    message: /already in flight/,
  });
});

test('a failed write-ahead releases the slot and records nothing', async t => {
  const ledger = makeTurnLedger({
    persist: async () => {
      throw Error('petstore is full');
    },
  });
  await t.throwsAsync(ledger.begin({ baseCheckpoint: null }), {
    message: /petstore is full/,
  });
  t.deepEqual(ledger.status(), {
    inFlight: false,
    needsReconciliation: false,
  });
  t.is(ledger.getRecord(), undefined);
});

test('a base checkpoint must be a checkpoint or nothing', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  await t.throwsAsync(
    ledger.begin({ baseCheckpoint: /** @type {any} */ ('') }),
    { message: /non-empty string or null/ },
  );
  await t.throwsAsync(
    ledger.begin({ baseCheckpoint: /** @type {any} */ (7) }),
    { message: /non-empty string or null/ },
  );
});

test('a completed outcome must name its checkpoint', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: null });
  await t.throwsAsync(turn.settle(/** @type {any} */ ({ type: 'completed' })), {
    message: /must name its checkpoint/,
  });
  await t.throwsAsync(turn.settle(/** @type {any} */ ({ type: 'weird' })), {
    message: /Unknown turn outcome/,
  });
  // Neither rejected attempt latched the turn.
  t.true((await turn.settle({ type: 'aborted', reason: 'ok' })).accepted);
});

test('a marker loaded from durable state is outstanding from the start', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({
    persist: store.persist,
    recovery: { baseCheckpoint: 'turn-1', status: 'started' },
  });
  t.like(ledger.status(), { needsReconciliation: true });

  const reverts = [];
  const reverted = await ledger.reconcile({
    readLatestCheckpoint: async () => (reverts.length ? 'turn-1' : 'turn-2'),
    revertBefore: async before => {
      reverts.push(before);
    },
  });
  t.true(reverted);
  t.deepEqual(reverts, ['turn-2']);
  t.is(store.latest(), null);
  t.deepEqual(ledger.status(), {
    inFlight: false,
    needsReconciliation: false,
  });
});

test('reconciliation is idempotent when the checkpoint is already restored', async t => {
  const store = makeStore();
  const { audit, events } = makeAudit();
  const ledger = makeTurnLedger({
    persist: store.persist,
    audit,
    recovery: { baseCheckpoint: 'turn-1', status: 'started' },
  });
  const reverted = await ledger.reconcile({
    readLatestCheckpoint: async () => 'turn-1',
    revertBefore: async () => {
      t.fail('nothing should be reverted');
    },
  });
  t.false(reverted);
  t.true(events.some(event => event.includes('checkpoint-already-restored')));
  // And a second pass is a no-op rather than an error.
  t.false(
    await ledger.reconcile({
      readLatestCheckpoint: async () => {
        t.fail('nothing left to reconcile');
        return null;
      },
      revertBefore: async () => {},
    }),
  );
});

test('reconciliation quarantines rather than reverting the wrong turn', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({
    persist: store.persist,
    recovery: {
      baseCheckpoint: 'turn-1',
      checkpoint: 'turn-2',
      status: 'completed',
    },
  });
  // History moved on: something else appended after the unacknowledged turn.
  await t.throwsAsync(
    ledger.reconcile({
      readLatestCheckpoint: async () => 'turn-3',
      revertBefore: async () => t.fail('must not revert'),
    }),
    { message: /advanced beyond the unacknowledged turn/ },
  );
  t.like(ledger.status(), { needsReconciliation: true });

  const lost = makeTurnLedger({
    persist: store.persist,
    recovery: { baseCheckpoint: 'turn-1', status: 'started' },
  });
  await t.throwsAsync(
    lost.reconcile({
      readLatestCheckpoint: async () => null,
      revertBefore: async () => t.fail('must not revert'),
    }),
    { message: /lost the unacknowledged turn/ },
  );
});

test('a revert that does not restore the checkpoint is refused', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({
    persist: store.persist,
    recovery: { baseCheckpoint: 'turn-1', status: 'started' },
  });
  await t.throwsAsync(
    ledger.reconcile({
      readLatestCheckpoint: async () => 'turn-2',
      revertBefore: async () => {},
    }),
    { message: /did not restore the durable checkpoint/ },
  );
  t.like(ledger.status(), { needsReconciliation: true });
});

test('acknowledging the wrong checkpoint is refused, and a cleared one is idempotent', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: null });
  await turn.settle({ type: 'completed', checkpoint: 'turn-2' });
  await t.throwsAsync(ledger.acknowledge('turn-3'), {
    message: /not awaiting acknowledgement/,
  });
  await ledger.acknowledge('turn-2');
  // A consumer that acknowledges again after a crash is not told it erred.
  await ledger.acknowledge('turn-2');
  t.deepEqual(ledger.status(), {
    inFlight: false,
    needsReconciliation: false,
  });
});

test('an aborted turn cannot be acknowledged into a commit', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: 'turn-1' });
  await turn.settle({ type: 'failed', reason: 'provider error' });
  await t.throwsAsync(ledger.acknowledge('turn-2'), {
    message: /not awaiting acknowledgement/,
  });
  t.like(ledger.status(), { needsReconciliation: true });
});

test('a ledger requires a persist hook', t => {
  t.throws(() => makeTurnLedger(/** @type {any} */ ({})), {
    message: /requires a persist hook/,
  });
});

test('an in-flight turn id tightens reconciliation without settling the turn', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: 'turn-1' });
  await turn.observe('turn-2');
  t.deepEqual(store.latest(), {
    baseCheckpoint: 'turn-1',
    checkpoint: 'turn-2',
    status: 'started',
  });
  t.like(ledger.status(), { inFlight: true, needsReconciliation: true });

  // The turn then fails. Reconciliation can now tell that history has moved on
  // past the turn it dispatched, rather than reverting blind.
  await turn.settle({ type: 'failed', reason: 'provider error' });
  await t.throwsAsync(
    ledger.reconcile({
      readLatestCheckpoint: async () => 'turn-3',
      revertBefore: async () => t.fail('must not revert'),
    }),
    { message: /advanced beyond the unacknowledged turn/ },
  );
});

test('observing after settlement is refused and cannot rewrite the record', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: 'turn-1' });
  await turn.settle({ type: 'aborted', reason: 'interrupted' });
  await t.throwsAsync(turn.observe('turn-2'), {
    message: /already settled as "aborted"/,
  });
  t.deepEqual(ledger.getRecord(), {
    baseCheckpoint: 'turn-1',
    status: 'started',
  });
});

test('a settlement that lands during a slow observe keeps its record', async t => {
  const store = makeStore();
  const ledger = makeTurnLedger({ persist: store.persist });
  const turn = await ledger.begin({ baseCheckpoint: 'turn-1' });
  store.hold();
  const observing = turn.observe('turn-2');
  const settled = await turn.settle({ type: 'aborted', reason: 'interrupted' });
  t.true(settled.accepted);
  store.open();
  await observing;
  // The abort's record wins: the observe was in flight and must not restore a
  // "started" marker over the settled turn's state.
  t.deepEqual(ledger.getRecord(), {
    baseCheckpoint: 'turn-1',
    status: 'started',
  });
  t.like(ledger.status(), { inFlight: false, needsReconciliation: true });
});
