// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeSessionOwner } from '../src/session-owner.js';
import { makeDirectory } from './_session-record-directory.js';

const makeHarness = () => {
  const directory = makeDirectory();
  /** @type {unknown[][]} */
  const calls = [];
  const faults = { stop: false, remove: false, revoked: false };
  const client = Far('NativeClient', {
    send: async (/** @type {string} */ text) => {
      calls.push(['send', text]);
      return readerFromIterator(
        (async function* () {
          yield text;
        })(),
      );
    },
    interrupt: async () => {},
    status: async () => 'running',
    terminate: async () => {
      calls.push(['terminate']);
      if (faults.stop) throw Error('Native stop failed');
    },
    destroy: async () => {
      calls.push(['destroy']);
    },
  });
  const storage = Far('NativeStorage', {
    remove: async (/** @type {string} */ plan) => {
      calls.push(['remove', plan]);
      if (faults.remove) throw Error('Native removal failed');
    },
  });
  const provide = async (/** @type {string} */ id) => {
    calls.push(['provide', id]);
    if (id === 'client-id') return client;
    if (id === 'storage-id') return storage;
    throw Error('Unexpected authority resolution');
  };
  const powers = {
    directory,
    provide,
    cancel: async (/** @type {string} */ id, /** @type {Error} */ _reason) => {
      calls.push(['cancel', id]);
    },
    assertActive: () => {
      if (faults.revoked) throw Error('Host cancelled');
    },
  };
  const owner = makeSessionOwner(powers);
  const refs = harden({ client: 'client-id', storage: 'storage-id' });
  return { owner, powers, calls, faults, refs };
};

test('record inspection and client forwarding acquisition remain passive', async t => {
  const h = makeHarness();
  await E(h.owner).create('a', 'approved plan', h.refs);
  t.like(await E(h.owner).inspect('a'), {
    plan: 'approved plan',
    references: h.refs,
    phase: 'ready',
  });
  const client = await E(h.owner).client('a');
  t.deepEqual(h.calls, []);
  const reply = iterateReader(await E(client).send('hello'));
  t.deepEqual(await reply.next(), { done: false, value: 'hello' });
  await reply.return(undefined);
  t.deepEqual(h.calls, [
    ['provide', 'client-id'],
    ['send', 'hello'],
  ]);
});

test('failed stop fences the old handle and retains the exact client for retry', async t => {
  const h = makeHarness();
  await E(h.owner).create('a', 'approved plan', h.refs);
  const client = await E(h.owner).client('a');
  h.faults.stop = true;
  await t.throwsAsync(E(h.owner).stop('a'), { message: /Native stop failed/ });
  await t.throwsAsync(E(client).send('late'), { message: /stopped/ });
  await t.throwsAsync(E(h.owner).client('a'), { message: /stopped/ });
  t.deepEqual((await E(h.owner).inspect('a'))?.references, h.refs);
  t.false(h.calls.some(([kind]) => kind === 'cancel'));
  const recovered = makeSessionOwner(h.powers);
  t.is((await E(recovered).inspect('a'))?.phase, 'stopping');
  await t.throwsAsync(E(recovered).client('a'), {
    message: /stop must finish/,
  });
  await t.throwsAsync(E(recovered).revise('a', 'changed plan'), {
    message: /stop must finish/,
  });
  h.faults.stop = false;
  await E(recovered).stop('a');
  t.deepEqual((await E(h.owner).inspect('a'))?.references, {
    storage: 'storage-id',
  });
  t.deepEqual(h.calls.at(-1), ['cancel', 'client-id']);
  await t.throwsAsync(E(client).status(), { message: /stopped/ });
});

test('failed removal persists intent across owner reconstruction', async t => {
  const h = makeHarness();
  await E(h.owner).create('a', 'original paths', h.refs);
  h.faults.remove = true;
  await t.throwsAsync(E(h.owner).remove('a'), {
    message: /Native removal failed/,
  });
  const owner = makeSessionOwner(h.powers);
  t.is((await E(owner).inspect('a'))?.phase, 'removing');
  await t.throwsAsync(E(owner).client('a'), { message: /removal must finish/ });
  await t.throwsAsync(E(owner).revise('a', 'new paths'), {
    message: /removal must finish/,
  });
  h.faults.remove = false;
  await E(owner).remove('a');
  t.is(await E(owner).inspect('a'), undefined);
  t.deepEqual(h.calls.at(-1), ['remove', 'original paths']);
});

test('a stopped incarnation cannot dispatch after delayed capability resolution', async t => {
  t.timeout(5000);
  const h = makeHarness();
  const pending = makePromiseKit();
  const entered = makePromiseKit();
  let delayed = true;
  const owner = makeSessionOwner({
    ...h.powers,
    provide: async id => {
      if (delayed) {
        delayed = false;
        entered.resolve(undefined);
        await pending.promise;
      }
      return h.powers.provide(id);
    },
  });
  await E(owner).create('a', 'plan', h.refs);
  const client = await E(owner).client('a');
  const sent = E(client).send('stale');
  const rejected = t.throwsAsync(sent, { message: /stopped/ });
  await entered.promise;
  await E(owner).stop('a');
  pending.resolve(undefined);
  await rejected;
  t.false(h.calls.some(([kind]) => kind === 'send'));
});

test('parent host revocation closes owner and previously returned forwarding facets', async t => {
  const h = makeHarness();
  await E(h.owner).create('a', 'plan', h.refs);
  const client = await E(h.owner).client('a');
  h.faults.revoked = true;
  await t.throwsAsync(E(client).send('late'), { message: /Host cancelled/ });
  await t.throwsAsync(E(h.owner).inspect('a'), { message: /Host cancelled/ });
  t.deepEqual(h.calls, []);
});

test('incomplete adopted records retain cleanup authority rather than infer no effects', async t => {
  const h = makeHarness();
  const owner = makeSessionOwner({
    ...h.powers,
    directory: makeDirectory({ failPlan: true }),
  });
  await t.throwsAsync(E(owner).create('a', 'plan', h.refs), {
    message: /Plan write failed/,
  });
  await t.throwsAsync(E(owner).remove('a'), {
    message: /Incomplete session record requires its original cleanup plan/,
  });
  t.deepEqual((await E(owner).inspect('a'))?.references, h.refs);
  t.deepEqual(h.calls, []);
});

test('stop fences a client facet whose passive record read is still pending', async t => {
  t.timeout(5000);
  const h = makeHarness();
  const entered = makePromiseKit();
  const resume = makePromiseKit();
  const stopAdmitted = makePromiseKit();
  let delay = false;
  let observeStop = false;
  const owner = makeSessionOwner({
    ...h.powers,
    directory: harden({
      ...h.powers.directory,
      lookup: async (/** @type {string} */ name) => {
        if (delay) {
          delay = false;
          entered.resolve(undefined);
          await resume.promise;
        }
        return E(h.powers.directory).lookup(name);
      },
    }),
    assertActive: () => {
      h.powers.assertActive();
      if (observeStop) stopAdmitted.resolve(undefined);
    },
  });
  await E(owner).create('a', 'plan', h.refs);
  delay = true;
  const refused = t.throwsAsync(E(owner).client('a'), { message: /stopped/ });
  await entered.promise;
  observeStop = true;
  const stopped = E(owner).stop('a');
  await stopAdmitted.promise;
  resume.resolve(undefined);
  await Promise.all([refused, stopped]);
  t.false(h.calls.some(([kind]) => kind === 'send'));
});

for (const operation of ['send', 'status', 'interrupt', 'stop', 'remove']) {
  test(`owner exo refuses a raw capability rejection from ${operation}`, async t => {
    const h = makeHarness();
    const disposable = Far('Disposable rejection', {});
    const fail = async () => {
      throw disposable;
    };
    const client = Far('Rejecting native client', {
      send: fail,
      status: fail,
      interrupt: fail,
      terminate: fail,
      destroy: fail,
    });
    const owner = makeSessionOwner({
      ...h.powers,
      provide: async () => client,
    });
    await E(owner).create('a', 'plan', h.refs);
    const forwarded = await E(owner).client('a');
    const operationPromise =
      operation === 'stop'
        ? E(owner).stop('a')
        : operation === 'remove'
          ? E(owner).remove('a')
          : operation === 'send'
            ? E(forwarded).send('text')
            : E(forwarded)[operation]();
    await t.throwsAsync(operationPromise, {
      instanceOf: Error,
      message: /not throwable/,
    });
  });
}

test('owner exo refuses a nested capability rejection from storage cleanup', async t => {
  const h = makeHarness();
  const disposable = Far('Disposable storage rejection', {});
  const owner = makeSessionOwner({
    ...h.powers,
    provide: async () =>
      Far('Rejecting storage', {
        remove: async () => {
          throw harden({ nested: disposable });
        },
      }),
  });
  await E(owner).create('a', 'plan', { storage: 'storage-id' });
  await t.throwsAsync(E(owner).remove('a'), {
    instanceOf: Error,
    message: /not throwable/,
  });
  t.deepEqual((await E(owner).inspect('a'))?.references, {
    storage: 'storage-id',
  });
});
