// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { makePromiseKit } from '@endo/promise-kit';

import { makeNativeProducerLifecycle } from '../src/native-producer-lifecycle.js';

const manifest = harden({
  version: /** @type {const} */ (1),
  sessionId: 'session',
  ownerId: 'owner',
  incarnation: 'incarnation',
  releaseId: 'release',
  roles: ['sandbox', 'listener'],
  adapterRef: 'opaque-adapter-reference',
});

const fixture = () => {
  /** @type {import('../src/native-producer-lifecycle.js').ProducerRecord | undefined} */
  let record;
  const events = [];
  let failWrite = false;
  let writeThenFail = false;
  const store = {
    async read() {
      return record;
    },
    async compareAndAppend(expected, next) {
      if (expected !== record?.revision) throw Error('conflict');
      if (failWrite) throw Error('write failed');
      record = next;
      events.push(next.phase);
      if (writeThenFail) throw Error('write acknowledgement lost');
    },
  };
  const proof = harden({ manifest, evidence: 'opaque-proof' });
  const adapter = {
    async admit(_manifest, admission, _request) {
      events.push(admission.operationId);
      return 'result';
    },
    async fenceAndStop() {
      events.push('stop');
      return proof;
    },
    async reconcile() {
      events.push('reconcile');
      return proof;
    },
  };
  return {
    store,
    adapter,
    events,
    proof,
    open: (identity = manifest) =>
      makeNativeProducerLifecycle({ manifest: identity, store, adapter }),
    fail: () => {
      failWrite = true;
    },
    loseAck: () => {
      writeThenFail = true;
    },
    recover: () => {
      failWrite = false;
      writeThenFail = false;
    },
  };
};

test('manifest and admission intent precede effects; receipt precedes retirement acknowledgement', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  t.is(await owner.admit('sandbox', 'create-1', {}), 'result');
  await owner.retire();
  t.deepEqual(f.events, [
    'active',
    'active',
    'create-1',
    'retiring',
    'stop',
    'stopped',
    'reconcile',
    'retired',
  ]);
  await t.throwsAsync(owner.admit('sandbox', 'create-2', {}), {
    message: /retiring/,
  });
  await t.throwsAsync(f.open().initialize(), { message: /cannot restart/ });
});

test('no missing manifest cleanup, changed identity, unapproved role, or reused operation', async t => {
  const f = fixture();
  await t.throwsAsync(f.open().retire(), {
    message: /Missing producer manifest/,
  });
  const owner = f.open();
  await owner.initialize();
  await t.throwsAsync(owner.admit('credential', 'one', {}), {
    message: /Unapproved/,
  });
  await owner.admit('sandbox', 'one', {});
  await t.throwsAsync(owner.admit('sandbox', 'one', {}), {
    message: /already admitted/,
  });
  await t.throwsAsync(
    f.open({ ...manifest, releaseId: 'other' }).initialize(),
    { message: /manifest changed/ },
  );
  t.false(f.events.includes('stop'));
});

test('failed publication dispatches nothing and poisons old instance', async t => {
  const f = fixture();
  const owner = f.open();
  f.fail();
  await t.throwsAsync(owner.initialize(), { message: /write failed/ });
  f.recover();
  await t.throwsAsync(owner.initialize(), { message: /uncertain/ });
  t.deepEqual(f.events, []);
  await f.open().initialize();
});

test('write then lost acknowledgement retains admission and forbids replay on reconstruction', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  f.loseAck();
  await t.throwsAsync(owner.admit('sandbox', 'one', {}), {
    message: /acknowledgement lost/,
  });
  f.recover();
  const reconstructed = f.open();
  await t.throwsAsync(reconstructed.admit('sandbox', 'one', {}), {
    message: /already admitted/,
  });
  await reconstructed.retire();
  t.false(f.events.includes('one'));
});

test('stop starts without waiting for admitted reply; handoff waits for that continuation', async t => {
  t.timeout(2000);
  const f = fixture();
  const admitted = makePromiseKit();
  const reply = makePromiseKit();
  f.adapter.admit = async () => {
    admitted.resolve(undefined);
    return reply.promise;
  };
  const owner = f.open();
  await owner.initialize();
  const sending = owner.admit('sandbox', 'one', {});
  await admitted.promise;
  let complete = false;
  const closing = owner.retire().then(() => {
    complete = true;
  });
  await t.throwsAsync(owner.admit('sandbox', 'two', {}), {
    message: /retiring/,
  });
  await new Promise(resolve => setImmediate(resolve));
  t.true(f.events.includes('stop'));
  t.false(complete);
  reply.reject(Error('admission outcome unknown'));
  await t.throwsAsync(sending, { message: /unknown/ });
  await closing;
});

test('failed reconcile retries exact stopped incarnation without repeating stop', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  f.adapter.reconcile = async () => {
    throw Error('cleanup pending');
  };
  await t.throwsAsync(owner.retire(), { message: /cleanup pending/ });
  t.is((await owner.status())?.phase, 'stopped');
  f.adapter.reconcile = async () => f.proof;
  await f.open().retire();
  t.is(f.events.filter(event => event === 'stop').length, 1);
});

test('mismatched shutdown proof cannot authorize cleanup', async t => {
  const f = fixture();
  f.adapter.fenceAndStop = async () => ({
    manifest: { ...manifest, incarnation: 'other' },
    evidence: 'wrong',
  });
  const owner = f.open();
  await owner.initialize();
  await t.throwsAsync(owner.retire(), { message: /proof identity changed/ });
  t.false(f.events.includes('reconcile'));
});

test('lost retirement receipt acknowledgement is recovered without replaying cleanup', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  f.adapter.reconcile = async () => {
    f.loseAck();
    return f.proof;
  };
  await t.throwsAsync(owner.retire(), { message: /acknowledgement lost/ });
  f.recover();
  t.deepEqual(await f.open().retire(), f.proof);
  t.is((await f.store.read())?.phase, 'retired');
});

test('failed durable fence cannot invoke stop or cleanup', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  f.fail();
  await t.throwsAsync(owner.retire(), { message: /write failed/ });
  t.false(f.events.includes('stop'));
  t.false(f.events.includes('reconcile'));
});

test('unknown stop outcome retains retirement and never calls reconcile before proof', async t => {
  const f = fixture();
  const owner = f.open();
  await owner.initialize();
  f.adapter.fenceAndStop = async () => {
    throw Error('stop outcome unknown');
  };
  await t.throwsAsync(owner.retire(), { message: /stop outcome unknown/ });
  t.is((await owner.status())?.phase, 'retiring');
  t.false(f.events.includes('reconcile'));
  f.adapter.fenceAndStop = async () => f.proof;
  await owner.retire();
});

test('late successful admission result is not exposed after local retirement', async t => {
  t.timeout(2000);
  const f = fixture();
  const dispatched = makePromiseKit();
  const reply = makePromiseKit();
  f.adapter.admit = async () => {
    dispatched.resolve(undefined);
    return reply.promise;
  };
  const owner = f.open();
  await owner.initialize();
  const sending = owner.admit('sandbox', 'one', {});
  await dispatched.promise;
  const closing = owner.retire();
  reply.resolve('old native authority');
  await t.throwsAsync(sending, { message: /retiring/ });
  await closing;
});
