// @ts-check

/* eslint-disable no-await-in-loop */

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { prepareChildAgentCoordinator } from '../index.js';
import { LIFECYCLE_NAME } from '../src/coordinator.js';
import { makeFakeDaemon } from './_fake-host.js';

// A crash loses its class crossing an exo boundary, so match its message.
const crashPattern = /^(crash at|dead incarnation)/;

const rootPolicy = {
  maxChildren: 3,
  maxInstructionBytes: 64,
  endowmentNames: ['notes', 'workspace'],
};

/** @param {ReturnType<typeof makeFakeDaemon>} daemon */
const boot = daemon =>
  prepareChildAgentCoordinator({
    host: daemon.host,
    rootPolicy,
    now: () => 1000,
  });

const setup = async () => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker, calls } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  return { daemon, coordinator, maker, calls, bound };
};

test('create commits a child with exactly its endowments', async t => {
  const { daemon, bound, calls } = await setup();
  const notes = Far('Notes', {});
  const { summary, handle } = await E(bound).create('helper', {
    instructions: 'Summarize.',
    endowments: { notes },
  });
  t.like(summary, { name: 'helper', phase: 'Committed', createdAt: 1000 });
  t.is(typeof summary.operationId, 'string');
  t.deepEqual(Object.keys(summary).sort(), [
    'createdAt',
    'name',
    'operationId',
    'phase',
  ]);
  t.is(await E(bound).lookup('helper'), handle);

  t.is(calls.length, 1);
  t.is(calls[0].instructions, 'Summarize.');
  t.true(await E(calls[0].lifecycle).isActive());

  const guestName = daemon.trace
    .find(label => label.startsWith('name guest '))
    ?.slice('name guest '.length);
  t.truthy(guestName);
  const guestEntries = await E(daemon.host).list(
    /** @type {string} */ (guestName),
  );
  t.deepEqual(guestEntries, ['@self', 'notes']);
  t.is(
    await E(daemon.host).lookup(/** @type {string} */ (guestName), 'notes'),
    notes,
  );
  t.is(daemon.running().length, 1, 'the runner was started');
});

test('policy refusal has no side effects', async t => {
  const { daemon, bound } = await setup();
  const before = daemon.effects;
  await t.throwsAsync(E(bound).create('a', { instructions: 'x'.repeat(65) }), {
    message: /64-byte bound/,
  });
  await t.throwsAsync(
    E(bound).create('a', { endowments: { secrets: Far('S', {}) } }),
    { message: /does not admit/ },
  );
  await t.throwsAsync(E(bound).create('@self'), { message: /ordinary/ });
  t.is(daemon.effects, before);
  t.deepEqual(await E(bound).list(), []);
});

test('bind and attenuate can only reduce policy and quota is nested', async t => {
  const { coordinator, maker } = await setup();
  const narrow = await E(coordinator.rootFacet).bind(maker, {
    maxChildren: 99,
    endowmentNames: ['notes', 'unlisted'],
  });
  await t.throwsAsync(
    E(narrow).create('a', { endowments: { workspace: Far('W', {}) } }),
    { message: /does not admit/ },
  );
  const derived = await E(narrow).attenuate('sub', { maxChildren: 99 });
  await E(derived).create('helper');
  await E(derived).create('helper2');
  await E(narrow).create('helper');
  // The root admits three; attenuation does not multiply it.
  await t.throwsAsync(E(derived).create('helper3'), { message: /quota/ });
  await t.throwsAsync(E(narrow).create('other'), { message: /quota/ });
  t.deepEqual(await E(narrow).listDerived(), [
    { name: 'sub', phase: 'Active', retainedChildren: 2 },
  ]);
});

test('separate namespaces each own a child named helper', async t => {
  const { coordinator, maker, bound } = await setup();
  const other = await E(coordinator.rootFacet).bind(maker);
  const derived = await E(bound).attenuate('sub', {});
  await E(bound).create('helper');
  await E(other).create('helper');
  await E(derived).create('helper');
  const [a] = await E(bound).list();
  const [b] = await E(other).list();
  t.not(a.operationId, b.operationId);
  await E(other).remove('helper');
  t.is((await E(bound).list()).length, 1);
  t.is((await E(derived).list()).length, 1);
  t.not(await E(bound).lookup('helper'), await E(derived).lookup('helper'));
});

test('operation semantics: duplicate, unknown, and removed names', async t => {
  const { bound, daemon } = await setup();
  await E(bound).create('helper');
  await t.throwsAsync(E(bound).create('helper'), { message: /Committed/ });
  await t.throwsAsync(E(bound).remove('nobody'), { message: /No child/ });
  await t.throwsAsync(E(bound).lookup('nobody'), { message: /No committed/ });
  const first = E(bound).remove('helper');
  const second = E(bound).remove('helper');
  await Promise.all([first, second]);
  await t.throwsAsync(E(bound).remove('helper'), { message: /No child/ });
  t.deepEqual(await E(bound).list(), []);
  t.is(daemon.running().length, 0, 'removal tore the runner down');
  // The name is free again.
  await E(bound).create('helper');
});

test('maker failure during create rolls the child back', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const maker = Far('AgentDriverMaker', {
    async installDriver() {
      throw Error('provider refused');
    },
  });
  const bound = await E(coordinator.rootFacet).bind(maker);
  await t.throwsAsync(E(bound).create('helper'), {
    message: 'provider refused',
  });
  t.deepEqual(await E(bound).list(), []);
  const leftovers = [...daemon.names.keys()].filter(name =>
    name.startsWith('c'),
  );
  t.deepEqual(leftovers, []);
});

test('revokeDerived reclaims a derived namespace without its facet', async t => {
  const { bound, coordinator } = await setup();
  const derived = await E(bound).attenuate('sub', {});
  const nested = await E(derived).attenuate('deeper', {});
  await E(derived).create('a');
  await E(nested).create('b');
  await E(coordinator.rootFacet).revokeDerived('bind-1');
  await t.throwsAsync(E(bound).list(), { message: /revoked/ });
  await t.throwsAsync(E(derived).create('c'), { message: /revoked/ });
  await t.throwsAsync(E(nested).list(), { message: /revoked/ });
  t.deepEqual(await E(coordinator.rootFacet).listDerived(), []);
  const { maker } = makeFakeDaemon().makeMaker();
  const fresh = await E(coordinator.rootFacet).bind(maker);
  // Every quota slot came back.
  await E(fresh).create('x');
  await E(fresh).create('y');
  await E(fresh).create('z');
});

test('the handle exposes none of the child powers', async t => {
  const { bound } = await setup();
  const { handle } = await E(bound).create('helper');
  t.deepEqual(Object.keys(handle), []);
});

test('a committed child resumes after restart with no holder call', async t => {
  const daemon = makeFakeDaemon();
  const first = await boot(daemon);
  const { maker } = daemon.makeMaker();
  const bound = await E(first.rootFacet).bind(maker);
  await E(bound).create('helper');
  daemon.forgetIncarnations();
  t.is(daemon.running().length, 0);
  const second = await boot(daemon);
  t.is(daemon.running().length, 1, 'reconciliation started the runner');
  const revived = second.boundFacet(1);
  t.deepEqual(
    (await E(revived).list()).map(s => s.name),
    ['helper'],
  );
});

test('a child that clears its own @pins still resumes', async t => {
  const { daemon, bound } = await setup();
  await E(bound).create('helper');
  const guestName = /** @type {string} */ (
    [...daemon.names.keys()].find(name => name.endsWith('.guest'))
  );
  daemon.guestWrite(guestName, 'pins-replacement', Far('Junk', {}));
  daemon.forgetIncarnations();
  await boot(daemon);
  t.is(daemon.running().length, 1);
});

test('a runner revived during removal sees an inactive lifecycle', async t => {
  const { daemon, bound, calls } = await setup();
  await E(bound).create('helper');
  const { lifecycle } = calls[0];
  const follower = await E(lifecycle).followActive();
  t.deepEqual(await E(follower).next(), { done: false, value: true });
  const next = E(follower).next();
  // Crash at the first effect after `Removing` is appended.
  daemon.crashAfter(2);
  await t.throwsAsync(E(bound).remove('helper'), { message: crashPattern });
  t.deepEqual(await next, { done: false, value: false });
  t.false(await E(lifecycle).isActive());
  daemon.restart();
  await boot(daemon);
  t.is(daemon.running().length, 0);
});

test('a wrong formula type at a derived name fails closed', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  // Plant a non-guest at the first operation's guest name, as only a
  // coordinator defect could.
  await E(daemon.host).storeValue(Far('Squatter', {}), 'c1.0.guest');
  await t.throwsAsync(E(bound).create('helper'), {
    message: /expected "guest"/,
  });
  const [summary] = await E(bound).list();
  t.is(summary.phase, 'Intended', 'the name stays reserved');
  t.true(await E(daemon.host).has('c1.0.guest'), 'nothing was deleted');
  await t.throwsAsync(E(bound).remove('helper'), { message: /fault/ });
  const revived = await boot(daemon);
  t.regex(Object.values(revived.faults())[0], /expected "guest"/);
});

/**
 * Crash at every effect of `scenario` in turn, then restart and check that
 * the state converged.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {(ctx: { bound: any, coordinator: any, daemon: any }) => Promise<void>} prepare
 * @param {(ctx: { bound: any, coordinator: any, daemon: any }) => Promise<void>} scenario
 * @param {(ctx: { daemon: any, revived: any, crashed: boolean }) => Promise<void>} check
 */
const crashMatrix = async (t, prepare, scenario, check) => {
  await null;
  let cut = 1;
  for (;;) {
    const daemon = makeFakeDaemon();
    const coordinator = await boot(daemon);
    const { maker } = daemon.makeMaker();
    const bound = await E(coordinator.rootFacet).bind(maker);
    await prepare({ bound, coordinator, daemon });
    daemon.crashAfter(cut);
    let crashed = false;
    try {
      await scenario({ bound, coordinator, daemon });
    } catch (error) {
      if (!crashPattern.test(/** @type {Error} */ (error).message)) throw error;
      crashed = true;
    }
    daemon.restart();
    daemon.forgetIncarnations();
    const revived = await boot(daemon);
    await check({ daemon, revived, crashed });
    if (!crashed) break;
    cut += 1;
  }
  t.true(cut > 3, `the matrix exercised ${cut} cuts`);
};

test('recovery matrix: create converges to exactly one child or none', async t => {
  const notes = Far('Notes', {});
  await crashMatrix(
    t,
    async () => {},
    async ({ bound }) => {
      await E(bound).create('helper', { endowments: { notes } });
    },
    async ({ daemon, revived }) => {
      const bound = revived.boundFacet(1);
      /** @type {any[]} */
      const children = await E(bound).list();
      t.true(children.length <= 1);
      const guests = [...daemon.names.keys()].filter(n => n.endsWith('.guest'));
      const responders = [...daemon.names.keys()].filter(n =>
        n.endsWith('.responder'),
      );
      if (children.length === 1) {
        t.is(children[0].phase, 'Committed');
        t.is(guests.length, 1);
        t.is(responders.length, 1);
        t.is(daemon.running().length, 1, 'exactly one runner');
        const guestName = guests[0];
        t.deepEqual(await E(daemon.host).list(guestName), ['@self', 'notes']);
        const driverName = guestName.replace(/guest$/, 'driver');
        t.true(await E(daemon.host).has(driverName, LIFECYCLE_NAME));
        // Exactly one named unconfined formula, over the recorded driver.
        const named = daemon.formulaAt(responders[0]);
        t.is(named.powers, await E(daemon.host).identify(driverName));
      } else {
        t.deepEqual(guests, []);
        t.is(daemon.running().length, 0);
      }
    },
  );
});

test('recovery matrix: removal converges with nothing left', async t => {
  await crashMatrix(
    t,
    async ({ bound }) => {
      await E(bound).create('helper', { endowments: { notes: Far('N', {}) } });
    },
    async ({ bound }) => {
      await E(bound).remove('helper');
    },
    async ({ daemon, revived, crashed }) => {
      const bound = revived.boundFacet(1);
      const children = await E(bound).list();
      const pieces = [...daemon.names.keys()].filter(n => n.startsWith('c'));
      if (children.length === 1) {
        // Only a crash before `Removing` was appended leaves it committed.
        t.true(crashed);
        t.is(children[0].phase, 'Committed');
      } else {
        t.deepEqual(pieces, []);
        t.is(daemon.running().length, 0);
      }
    },
  );
});

test('recovery matrix: revokeDerived converges to Revoked', async t => {
  await crashMatrix(
    t,
    async ({ bound }) => {
      const derived = await E(bound).attenuate('sub', {});
      await E(derived).create('a');
      const nested = await E(derived).attenuate('deeper', {});
      await E(nested).create('b');
    },
    async ({ bound }) => {
      await E(bound).revokeDerived('sub');
    },
    async ({ daemon, revived }) => {
      const bound = revived.boundFacet(1);
      const derived = await E(bound).listDerived();
      if (derived.length === 1 && derived[0].phase === 'Active') {
        t.is(derived[0].retainedChildren, 2);
        return;
      }
      t.deepEqual(derived, []);
      const pieces = [...daemon.names.keys()].filter(n => n.startsWith('c'));
      t.deepEqual(pieces, []);
      await t.throwsAsync(E(revived.boundFacet(2)).list(), {
        message: /revoked/,
      });
      // Every ancestor quota slot was released.
      await E(bound).create('x');
      await E(bound).create('y');
      await E(bound).create('z');
    },
  );
});

test('makeUnconfined crash before the name write yields one named responder', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker, calls } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  // Find the cut that lands on the responder formulation itself.
  const probe = makeFakeDaemon();
  const probeCoordinator = await boot(probe);
  const probeBound = await E(probeCoordinator.rootFacet).bind(
    probe.makeMaker().maker,
  );
  const start = probe.effects;
  await E(probeBound).create('helper');
  const cut = probe.trace.indexOf('formulate responder', start) - start + 1;

  daemon.crashAfter(cut);
  await t.throwsAsync(E(bound).create('helper'), { message: crashPattern });
  t.is(daemon.unconfined().length, 1, 'one orphan formula');
  daemon.restart();
  await boot(daemon);
  t.is(calls.length, 2, 'replay formulated exactly one replacement');
  const named = [...daemon.names.keys()].filter(n => n.endsWith('.responder'));
  t.is(named.length, 1);
  t.is(daemon.running().length, 1);
});

test('a pre-bound endowment with a different identifier fails closed', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  const probe = makeFakeDaemon();
  const probeBound = await E((await boot(probe)).rootFacet).bind(
    probe.makeMaker().maker,
  );
  const start = probe.effects;
  await E(probeBound).create('helper', { endowments: { notes: Far('N', {}) } });
  const cut =
    probe.trace.findIndex(
      (label, i) => i >= start && label.startsWith('name guest'),
    ) -
    start +
    2;
  // Crash right after the GuestCreated entry, then let the "child" bind
  // `notes` to something else, which only a defect could do.
  daemon.crashAfter(cut);
  await t.throwsAsync(
    E(bound).create('helper', { endowments: { notes: Far('N', {}) } }),
    { message: crashPattern },
  );
  daemon.restart();
  daemon.guestWrite('c1.0.guest', 'notes', Far('Other', {}));
  const revived = await boot(daemon);
  t.regex(Object.values(revived.faults())[0], /another value/);
  const [summary] = await E(revived.boundFacet(1)).list();
  t.is(summary.phase, 'GuestCreated');
});

test('a stray name in the child directory fails closed', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker } = daemon.makeMaker();
  const bound = await E(coordinator.rootFacet).bind(maker);
  const probe = makeFakeDaemon();
  const probeBound = await E((await boot(probe)).rootFacet).bind(
    probe.makeMaker().maker,
  );
  const start = probe.effects;
  await E(probeBound).create('helper', { endowments: { notes: Far('N', {}) } });
  const cut =
    probe.trace.findIndex(
      (label, i) => i >= start && label.startsWith('name guest'),
    ) -
    start +
    2;
  daemon.crashAfter(cut);
  await t.throwsAsync(
    E(bound).create('helper', { endowments: { notes: Far('N', {}) } }),
    { message: crashPattern },
  );
  daemon.restart();
  daemon.guestWrite('c1.0.guest', 'stray', Far('Stray', {}));
  const revived = await boot(daemon);
  t.regex(Object.values(revived.faults())[0], /expected exactly/);
  const [summary] = await E(revived.boundFacet(1)).list();
  t.is(summary.phase, 'GuestCreated');
});

test('a responder formulated with other powers fails closed', async t => {
  const daemon = makeFakeDaemon();
  const coordinator = await boot(daemon);
  const { maker: honest } = daemon.makeMaker();
  // A defective maker that formulates the responder over the agent guest
  // rather than the driver guest.
  const maker = Far('AgentDriverMaker', {
    installDriver: (/** @type {any} */ context) =>
      E(honest).installDriver({ ...context, driverGuest: context.agent }),
  });
  const bound = await E(coordinator.rootFacet).bind(maker);
  const probe = makeFakeDaemon();
  const probeBound = await E((await boot(probe)).rootFacet).bind(
    probe.makeMaker().maker,
  );
  const start = probe.effects;
  await E(probeBound).create('helper');
  // Crash at the first effect after the responder name write, so replay
  // must prove the bound responder.
  const cut = probe.trace.indexOf('store c1.0.responder', start) - start + 2;
  daemon.crashAfter(cut);
  await t.throwsAsync(E(bound).create('helper'), { message: crashPattern });
  daemon.restart();
  const revived = await boot(daemon);
  t.regex(Object.values(revived.faults())[0], /other powers/);
  const [summary] = await E(revived.boundFacet(1)).list();
  t.is(summary.phase, 'DriverCreated');
  t.true(await E(daemon.host).has('c1.0.responder'), 'nothing was deleted');
});

test('a stale retained endowment is replaced before the operation starts', async t => {
  const { daemon, bound } = await setup();
  const notes = Far('Notes', {});
  await E(daemon.host).storeValue(Far('Stale', {}), 'c1.0.e0');
  const { summary } = await E(bound).create('helper', {
    endowments: { notes },
  });
  t.is(summary.phase, 'Committed');
  t.is(await E(daemon.host).lookup('c1.0.guest', 'notes'), notes);
});
