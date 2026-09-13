// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSessionOwner } from '../src/session-owner.js';
import { makeDirectory } from './_session-record-directory.js';

/** @import { SessionRecordDirectory } from '../src/session-record-store.js' */

const harness = () => {
  const faults = {
    failReference: '',
    failRemove: '',
    activate: false,
    detached: false,
  };
  const directory = makeDirectory(faults);
  /** @type {unknown[][]} */
  const calls = [];
  let construct = async () => {};
  let activate = async () => {};
  let terminate = async () => {};
  let retainedResolver;
  const entry = () =>
    /** @type {Promise<SessionRecordDirectory>} */ (directory.lookup('a'));
  const phase = async () => (await entry()).maybeReadText('lifecycle');
  const dependency = Far('Dependency', {});
  let getDependency = async () => dependency;
  const target = Far('NativeController', {
    activate: async (plan, resolver) => {
      calls.push(['activate', plan, await phase()]);
      retainedResolver = resolver;
      const pending = E(resolver).get('dependency');
      if (faults.detached) void pending.catch(() => {});
      else await pending;
      await activate();
      if (faults.activate) throw Error('Activation failed');
    },
    status: async () => 'ready',
    terminate: async () => {
      calls.push(['terminate']);
      await terminate();
    },
    destroy: async () => {
      calls.push(['destroy']);
    },
  });
  const powers = {
    directory,
    provide: async id => {
      calls.push(['provide', id, await phase()]);
      if (id === 'client-id') return target;
      if (id === 'dependency-id') return getDependency();
      throw Error('Unexpected revival');
    },
    cancel: async () => {
      throw Error('Reviving cancellation is forbidden');
    },
    native: {
      provideClient: id => powers.provide(id),
      construct: async (name, publish) => {
        calls.push(['construct', name, await phase()]);
        await publish('worker-id', 'client-id');
        await construct();
        return target;
      },
      cancel: async id => {
        calls.push(['cancel', id]);
      },
    },
  };
  return {
    powers,
    owner: makeSessionOwner(powers),
    calls,
    faults,
    phase,
    resolver: () => retainedResolver,
    holdDependency: fn => {
      getDependency = fn;
    },
    holdConstruction: fn => {
      construct = fn;
    },
    holdActivation: fn => {
      activate = fn;
    },
    onTerminate: fn => {
      terminate = fn;
    },
  };
};

test('native construction is retained before activation-time dependency revival', async t => {
  const h = harness();
  await E(h.owner).create('a', 'approved plan', {
    dependency: 'dependency-id',
  });
  t.is((await E(h.owner).inspect('a'))?.phase, 'planned');
  t.deepEqual(h.calls, []);
  const client = await E(h.owner).start('a');
  t.is(await E(client).status(), 'ready');
  t.deepEqual(h.calls, [
    ['construct', 'a', 'constructing'],
    ['activate', 'approved plan', 'starting'],
    ['provide', 'dependency-id', 'starting'],
  ]);
  t.deepEqual((await E(h.owner).inspect('a'))?.references, {
    dependency: 'dependency-id',
    worker: 'worker-id',
    client: 'client-id',
  });
  await E(h.owner).stop('a');
  await t.throwsAsync(E(h.resolver()).get('dependency'), {
    message: /stopped|interrupted/,
  });
  t.is((await E(h.owner).inspect('a'))?.phase, 'stopped');
  t.deepEqual(h.calls.slice(-3), [
    ['terminate'],
    ['cancel', 'client-id'],
    ['cancel', 'worker-id'],
  ]);
});

test('partial publication never activates and stop cancels without revival', async t => {
  const h = harness();
  await E(h.owner).create('a', 'plan', { dependency: 'dependency-id' });
  h.faults.failReference = 'client';
  await t.throwsAsync(E(h.owner).start('a'), {
    message: /Reference write failed/,
  });
  t.deepEqual((await E(h.owner).inspect('a'))?.references, {
    dependency: 'dependency-id',
    worker: 'worker-id',
  });
  await E(h.owner).stop('a');
  t.deepEqual(h.calls, [
    ['construct', 'a', 'constructing'],
    ['cancel', 'worker-id'],
  ]);
});

test('stop during admitted construction prevents activation and drains the constructor', async t => {
  t.timeout(5000);
  const h = harness();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  h.holdConstruction(async () => {
    entered.resolve(undefined);
    await release.promise;
  });
  t.teardown(() => release.resolve(undefined));
  await E(h.owner).create('a', 'plan', {});
  const starting = E(h.owner).start('a');
  const rejected = t.throwsAsync(starting, { message: /interrupted|stopped/ });
  await entered.promise;
  const stopping = E(h.owner).stop('a');
  let finished = false;
  void stopping.then(() => {
    finished = true;
  });
  await Promise.resolve();
  t.false(finished);
  release.resolve(undefined);
  await rejected;
  await stopping;
  t.false(h.calls.some(([kind]) => kind === 'activate' || kind === 'provide'));
});

test('reconstructed owners require explicit start and retain the original controller identity', async t => {
  const h = harness();
  await E(h.owner).create('a', 'plan', { dependency: 'dependency-id' });
  await E(h.owner).start('a');
  h.calls.length = 0;
  const owner = makeSessionOwner(h.powers);
  await E(owner).inspect('a');
  await t.throwsAsync(E(owner).client('a'), {
    message: /Explicit session start/,
  });
  t.deepEqual(h.calls, []);
  await E(owner).start('a');
  t.deepEqual(h.calls, [
    ['provide', 'client-id', 'ready'],
    ['activate', 'plan', 'starting'],
    ['provide', 'dependency-id', 'starting'],
  ]);
});

test('failed activation requires cleanup before replacement and removal uses original plan', async t => {
  const h = harness();
  await E(h.owner).create('a', 'original plan', {
    dependency: 'dependency-id',
  });
  h.faults.activate = true;
  await t.throwsAsync(E(h.owner).start('a'), { message: /Activation failed/ });
  await t.throwsAsync(E(h.owner).start('a'), { message: /must finish/ });
  await t.throwsAsync(E(h.owner).revise('a', 'replacement'), {
    message: /Stop the client/,
  });
  await E(h.owner).remove('a');
  t.deepEqual(h.calls.slice(-3), [
    ['terminate'],
    ['cancel', 'client-id'],
    ['cancel', 'worker-id'],
  ]);
  t.is(await E(h.owner).inspect('a'), undefined);
});

test('removal drains detached dependency revival before cancelling formulas', async t => {
  t.timeout(5000);
  const h = harness();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  let effect = false;
  h.faults.detached = true;
  h.holdDependency(async () => {
    entered.resolve(undefined);
    await release.promise;
    effect = true;
    return Far('LateDependency', {});
  });
  t.teardown(() => release.resolve(undefined));
  await E(h.owner).create('a', 'plan', { dependency: 'dependency-id' });
  await E(h.owner).start('a');
  await entered.promise;
  let removed = false;
  const removing = E(h.owner).remove('a');
  void removing.then(() => {
    removed = true;
  });
  await nextTurn();
  t.false(removed);
  t.false(h.calls.some(([kind]) => kind === 'cancel'));
  release.resolve(undefined);
  await removing;
  t.true(effect);
  t.is(await E(h.owner).inspect('a'), undefined);
});

test('reference deletion failure retries without calling the cancelled controller', async t => {
  const h = harness();
  await E(h.owner).create('a', 'plan', {});
  // The fixture normally requests this role during activate.
  h.faults.detached = true;
  await E(h.owner).start('a');
  h.faults.failRemove = 'worker';
  await t.throwsAsync(E(h.owner).stop('a'), {
    message: /Directory removal failed/,
  });
  h.faults.failRemove = '';
  await E(h.owner).stop('a');
  t.is(h.calls.filter(([kind]) => kind === 'terminate').length, 1);
  t.deepEqual((await E(h.owner).inspect('a'))?.references, {});
});

test('queued startup cannot clear a stop requested before it runs', async t => {
  const h = harness();
  await E(h.owner).create('a', 'plan', {});
  const starting = E(h.owner).start('a');
  const stopped = E(h.owner).stop('a');
  await t.throwsAsync(starting, { message: /interrupted|stopped/ });
  await stopped;
  t.false(h.calls.some(([kind]) => kind === 'construct'));
});

test('failed unstarted removal retains the original storage cleanup plan', async t => {
  const h = harness();
  const plans = [];
  let fail = true;
  const storage = Far('Storage', {
    remove: async plan => {
      plans.push(plan);
      if (fail) throw Error('Storage removal failed');
    },
  });
  const provide = h.powers.provide;
  const owner = makeSessionOwner({
    ...h.powers,
    provide: async id => (id === 'storage-id' ? storage : provide(id)),
  });
  await E(owner).create('a', 'original plan', { storage: 'storage-id' });
  await t.throwsAsync(E(owner).remove('a'), {
    message: /Storage removal failed/,
  });
  t.is((await E(owner).inspect('a'))?.phase, 'removing-unstarted');
  await t.throwsAsync(E(owner).revise('a', 'replacement'), {
    message: /cleanup must finish/,
  });
  fail = false;
  await E(owner).remove('a');
  t.deepEqual(plans, ['original plan', 'original plan']);
  t.is(await E(owner).inspect('a'), undefined);
});

test('a start queued during removal cannot enter a replacement session', async t => {
  t.timeout(5000);
  const h = harness();
  const entered = makePromiseKit();
  const release = makePromiseKit();
  t.teardown(() => release.resolve(undefined));
  const storage = Far('HeldStorage', {
    remove: async () => {
      entered.resolve(undefined);
      await release.promise;
    },
  });
  const provide = h.powers.provide;
  const owner = makeSessionOwner({
    ...h.powers,
    provide: async id => (id === 'storage-id' ? storage : provide(id)),
  });
  await E(owner).create('a', 'original plan', { storage: 'storage-id' });
  const removing = E(owner).remove('a');
  await entered.promise;
  const replacing = E(owner).create('a', 'replacement', {});
  const stale = t.throwsAsync(E(owner).start('a'), {
    message: /startup was interrupted/,
  });
  release.resolve(undefined);
  await removing;
  await replacing;
  await stale;
  t.false(h.calls.some(([kind]) => kind === 'construct'));
  h.faults.detached = true;
  t.is(await E(await E(owner).start('a')).status(), 'ready');
});

for (const failFirst of [false, true]) {
  test(`stop reaches cancellation-dependent activation${failFirst ? ' and retries failed termination' : ''}`, async t => {
    t.timeout(5000);
    const h = harness();
    const entered = makePromiseKit();
    const release = makePromiseKit();
    const failed = makePromiseKit();
    t.teardown(() => release.resolve(undefined));
    h.holdActivation(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    let attempts = 0;
    h.onTerminate(async () => {
      attempts += 1;
      if (failFirst && attempts === 1) {
        failed.resolve(undefined);
        throw Error('Termination failed');
      }
      release.resolve(undefined);
    });
    await E(h.owner).create('a', 'plan', { dependency: 'dependency-id' });
    const interrupted = t.throwsAsync(E(h.owner).start('a'), {
      message: /interrupted|stopped/,
    });
    await entered.promise;
    const stopping = E(h.owner).stop('a');
    if (failFirst) {
      await failed.promise;
      // The first attempt must settle before another stop can retry it.
      await nextTurn();
      await E(h.owner).stop('a');
    }
    await interrupted;
    await stopping;
    t.is(attempts, failFirst ? 2 : 1);
    t.is((await E(h.owner).inspect('a'))?.phase, 'stopped');
    t.deepEqual((await E(h.owner).inspect('a'))?.references, {
      dependency: 'dependency-id',
    });
  });
}
