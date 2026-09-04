// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';

import {
  makeSubagentSpawner,
  provisionFaeAgent,
  releaseFaeAgent,
  subagentAgentName,
  subagentNamesIn,
} from '../src/subagent-host.js';

/**
 * A host agent that records every namespace operation, so a test can assert on
 * what a half-built agent left behind.
 *
 * @param {object} [options]
 * @param {(step: { op: string, name: string }) => void} [options.onStep] -
 *   Throw from here to fail one provisioning step.
 */
const makeFakeHost = ({ onStep = () => {} } = {}) => {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {string[]} */
  const cancelled = [];
  /** @type {string[]} */
  const removed = [];
  let nextId = 0;

  /** Caplet result names keyed by the powers guest they die with. */
  /** @type {Map<string, string[]>} */
  const dependents = new Map();

  const bind = name => {
    nextId += 1;
    const id = `${name}-id-${nextId}`;
    names.set(name, id);
    return id;
  };

  /**
   * The daemon's `thisDiesIfThatDies(powersId)`: cancelling a powers guest
   * cancels the caplet running on it. Modelled here because teardown relies on
   * it — cancelling the caplet separately would be a second cancel, which
   * reincarnates rather than being idempotent.
   *
   * @param {string} name
   */
  const cascadeFrom = name => {
    for (const dependent of dependents.get(name) || []) {
      if (!cancelled.includes(dependent)) cancelled.push(dependent);
      cascadeFrom(dependent);
    }
  };

  const hostAgent = Far('HostAgent', {
    async list() {
      return harden([...names.keys()].sort());
    },
    async has(...petNamePath) {
      return names.has(petNamePath.join('/'));
    },
    async locate(...petNamePath) {
      const id = names.get(petNamePath.join('/'));
      return id === undefined ? undefined : `endo://node/${id}?type=handle`;
    },
    async provideGuest(name, options = {}) {
      onStep({ op: 'provideGuest', name });
      bind(name);
      if (options.agentName) bind(options.agentName);
      return Far('Guest', {
        async storeLocator() {
          return undefined;
        },
      });
    },
    async makeUnconfined(_worker, _specifier, options = {}) {
      onStep({ op: 'makeUnconfined', name: options.resultName });
      bind(options.resultName);
      const siblings = dependents.get(options.powersName) || [];
      siblings.push(options.resultName);
      dependents.set(options.powersName, siblings);
      return Far('Caplet', {});
    },
    async copy(from, to) {
      names.set(
        to.join('/'),
        /** @type {string} */ (names.get(from.join('/'))),
      );
    },
    async cancel(name) {
      cancelled.push(name);
      cascadeFrom(name);
    },
    async remove(...petNamePath) {
      const key = petNamePath.join('/');
      removed.push(key);
      names.delete(key);
    },
  });
  return { hostAgent, names, cancelled, removed };
};

const provisionOptions = {
  providerLocator: 'endo://node/provider?type=readable-blob',
  hostAgentLocator: 'endo://node/host?type=handle',
  driverSpecifier: 'file:///driver.js',
  spawnerSpecifier: 'file:///spawner.js',
};

test('provisioning releases a half-built agent when a later step fails', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost({
    onStep: step => {
      // The driver caplet is the last step; fail it once the spawner caplet is
      // already running.
      if (step.op === 'makeUnconfined' && step.name === 'parent-driver') {
        throw Error('worker refused the driver');
      }
    },
  });

  await t.throwsAsync(
    provisionFaeAgent({
      hostAgent,
      name: 'parent',
      depth: 0,
      maxDepth: 1,
      ...provisionOptions,
    }),
    { message: /worker refused the driver/ },
  );

  t.true(
    cancelled.includes('parent-spawner'),
    'the running spawner caplet must be cancelled, not abandoned',
  );
  t.false(
    names.has('parent-spawner'),
    'no name may still reach the spawner that held host-agent',
  );
  t.false(names.has('parent'), 'the agent guest must be released too');
});

test('releasing an agent cancels its guests, not only its caplets', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost();
  await provisionFaeAgent({
    hostAgent,
    name: 'parent',
    depth: 0,
    maxDepth: 1,
    ...provisionOptions,
  });

  await releaseFaeAgent({ hostAgent, name: 'parent' });

  for (const expected of [
    'parent-driver',
    'parent-spawner',
    'profile-for-parent-driver-handle',
    'profile-for-parent-spawner-handle',
    'profile-for-parent',
  ]) {
    t.true(cancelled.includes(expected), `${expected} should be cancelled`);
  }
  t.deepEqual([...names.keys()], []);
});

test('a subagent may not take a name the enumeration keys on', async t => {
  const { hostAgent } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'parent',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 1,
  });

  // A name carrying the infix's delimiter would make one tree's host names
  // indistinguishable from another's.
  await t.throwsAsync(spawner.spawn('a.sub.b'), {
    message: /must match/,
  });
  await t.throwsAsync(spawner.spawn('has.dot'), { message: /must match/ });
  // `parent`'s subagent `x-driver` would be the host agent
  // `parent.sub.x-driver` — the name sibling `x`'s driver caplet already
  // holds.
  await t.throwsAsync(spawner.spawn('x-driver'), {
    message: /must not end with/,
  });
  await t.throwsAsync(spawner.spawn('x-spawner'), {
    message: /must not end with/,
  });
  await t.throwsAsync(spawner.spawn('x-handle'), {
    message: /must not end with/,
  });

  t.is(subagentAgentName('parent', 'helper'), 'parent.sub.helper');
});

test('an agent is enumerated by its own handle, not by its driver', t => {
  // Keying the listing on `<child>-driver` meant a child whose driver was
  // cancelled first vanished from its parent's listing the moment that step
  // succeeded — even if a later step failed. It then counted against no bound,
  // no retry revisited it, and `spawn` refused the name forever because the
  // pre-check still saw the leftovers.
  //
  // `p`'s subagent `driver` has the handle `p.sub.driver`; the driver *caplet*
  // of subagent `x` is `p.sub.x-driver`, and the reserved suffix tells them
  // apart.
  t.deepEqual(
    subagentNamesIn(
      [
        'p.sub.driver',
        'p.sub.driver-driver',
        'p.sub.x',
        'p.sub.x-driver',
        'p.sub.x-spawner-handle',
      ],
      'p',
    ),
    ['driver', 'x'],
  );
  // A grandchild belongs to its own parent's listing: the inner segment
  // carries the infix, and an agent name may not contain its delimiter.
  t.deepEqual(subagentNamesIn(['p.sub.x.sub.y'], 'p'), []);
  t.deepEqual(subagentNamesIn(['p.sub.x.sub.y'], 'p.sub.x'), ['y']);
  t.deepEqual(subagentNamesIn(['other', 'profile-for-p.sub.x'], 'p'), []);
  // The delimiter is what makes the parse unambiguous. With a hyphenated
  // infix, root agents `p` and `p-sub` both claimed `p-sub-sub-x`, and `p`
  // could enumerate — and tear down — `p-sub`'s subagent.
  t.deepEqual(subagentNamesIn(['p-sub.sub.x'], 'p'), []);
  t.deepEqual(subagentNamesIn(['p-sub.sub.x'], 'p-sub'), ['x']);
});

test('provisioning refuses a name that would take one already in use', async t => {
  const { hostAgent, names } = makeFakeHost();
  await provisionFaeAgent({
    hostAgent,
    name: 'fae',
    depth: 0,
    maxDepth: 1,
    ...provisionOptions,
  });
  const before = [...names.keys()].sort();

  // `provideGuest` returns whatever a name already holds, of any type, so a
  // collision used to fail several steps later — and the rollback then removed
  // a name this call never bound. Here that would have unbound the live `fae`
  // agent's own guest.
  await t.throwsAsync(
    provisionFaeAgent({
      hostAgent,
      name: 'profile-for-fae',
      depth: 0,
      maxDepth: 1,
      ...provisionOptions,
    }),
    { message: /name "profile-for-fae" is already taken/ },
  );
  t.deepEqual([...names.keys()].sort(), before, 'nothing may be unbound');
});

test('a formula that could not be cancelled keeps the names that reach it', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost();
  await provisionFaeAgent({
    hostAgent,
    name: 'parent',
    depth: 0,
    maxDepth: 1,
    ...provisionOptions,
  });
  const stubborn = Far('HostAgent', {
    ...hostAgent,
    async cancel(name) {
      if (name === 'profile-for-parent-spawner-handle') {
        throw Error('graph lock unavailable');
      }
      return hostAgent.cancel(name);
    },
  });

  await t.throwsAsync(
    releaseFaeAgent({ hostAgent: stubborn, name: 'parent' }),
    {
      instanceOf: AggregateError,
      message: /retry once the cause is cleared/,
    },
  );
  // Not every cancel failure means the formula survived, but some do, and a
  // name is the only way back to whatever did — a running spawner caplet holds
  // `host-agent`.
  t.true(names.has('profile-for-parent-spawner-handle'));
  t.true(names.has('parent-spawner'));
  // What *was* cancelled loses its names in the same step, because `cancel` is
  // not idempotent: the daemon deletes the controller, so a second cancel of
  // the same id re-runs the formula before cancelling it again. A retry that
  // found these names still bound would reincarnate a driver it had already
  // destroyed.
  t.false(names.has('profile-for-parent-driver-handle'));
  t.false(names.has('parent-driver'));
  // The handle is what a parent enumerates by, so it survives a partial
  // teardown: an agent nothing can find is an agent no retry comes back for.
  t.true(names.has('parent'));

  // Retry once the cause has cleared.
  await releaseFaeAgent({ hostAgent, name: 'parent' });
  t.deepEqual([...names.keys()], []);
  t.is(
    cancelled.filter(entry => entry === 'profile-for-parent-driver-handle')
      .length,
    1,
    'a retry must not re-cancel — and so reincarnate — what is already gone',
  );
});

test('a stubborn grandchild leaves a retryable tree, not a resurrectable one', async t => {
  const { hostAgent, names, cancelled } = makeFakeHost();
  await provisionFaeAgent({
    hostAgent,
    name: 'p',
    depth: 0,
    maxDepth: 2,
    ...provisionOptions,
  });
  await provisionFaeAgent({
    hostAgent,
    name: 'p.sub.x',
    depth: 1,
    maxDepth: 2,
    ...provisionOptions,
  });
  await provisionFaeAgent({
    hostAgent,
    name: 'p.sub.x.sub.c',
    depth: 2,
    maxDepth: 2,
    ...provisionOptions,
  });
  const stubborn = Far('HostAgent', {
    ...hostAgent,
    async cancel(name) {
      if (name === 'profile-for-p.sub.x.sub.c-driver-handle') {
        throw Error('graph lock');
      }
      return hostAgent.cancel(name);
    },
  });

  await t.throwsAsync(
    releaseFaeAgent({ hostAgent: stubborn, name: 'p.sub.x' }),
    {
      instanceOf: AggregateError,
    },
  );
  // The parent's own caplets come down regardless — a spawner left running
  // holds `host-agent` — and what came down loses its names.
  t.true(cancelled.includes('p.sub.x-spawner'));
  t.false(names.has('p.sub.x-spawner'));
  // Both the grandchild and its parent stay enumerable. Keying the listing on
  // the driver meant a child whose driver went down first disappeared from it,
  // so no retry ever came back and `spawn` refused the name forever.
  t.deepEqual(subagentNamesIn([...names.keys()], 'p'), ['x']);
  t.deepEqual(subagentNamesIn([...names.keys()], 'p.sub.x'), ['c']);

  await releaseFaeAgent({ hostAgent, name: 'p.sub.x' });
  t.deepEqual(subagentNamesIn([...names.keys()], 'p'), []);
  t.false(names.has('p.sub.x.sub.c'));
  t.is(
    cancelled.filter(entry => entry === 'p.sub.x-spawner').length,
    1,
    'the retry must not reincarnate the spawner it already destroyed',
  );
  t.true(names.has('p'), 'the unrelated parent is untouched');
});

test('the subagent count bound is enforced', async t => {
  const { hostAgent } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'parent',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 1,
    maxSubagents: 2,
  });

  await spawner.spawn('one');
  await spawner.spawn('two');
  t.deepEqual(await spawner.list(), ['one', 'two']);
  await t.throwsAsync(spawner.spawn('three'), { message: /Subagent limit/ });
});

test('a subagent spawned during a teardown is not stranded', async t => {
  const { hostAgent, names } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'p',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 2,
  });
  await spawner.spawn('c');

  // Releasing children first left the agent answering mail and its spawner
  // minting agents throughout the recursion, so a subagent created in that
  // window was not in the snapshot, was never released, and afterwards was
  // reachable by nothing: its parent's spawner was gone, and the
  // grandparent's enumeration rejects a name a level too deep. Issuing both
  // at once is something a model can do — tool calls within a turn are not
  // ordered.
  const childSpawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'p.sub.c',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 2,
    maxDepth: 2,
  });
  const stopping = spawner.stop('c');
  const spawning = childSpawner.spawn('h').catch(() => 'refused');
  await stopping;
  const spawnOutcome = await spawning;

  const stranded = [...names.keys()].filter(name => name.startsWith('p.sub.c'));
  t.deepEqual(
    stranded,
    [],
    `nothing of the released subtree may survive (spawn: ${spawnOutcome})`,
  );
});

test('two stops of one subagent do not cancel it twice', async t => {
  const { hostAgent, cancelled } = makeFakeHost();
  const spawner = makeSubagentSpawner({
    provideContext: async () =>
      harden({
        hostAgent,
        providerLocator: provisionOptions.providerLocator,
        hostAgentLocator: provisionOptions.hostAgentLocator,
      }),
    parentName: 'p',
    driverSpecifier: provisionOptions.driverSpecifier,
    spawnerSpecifier: provisionOptions.spawnerSpecifier,
    depth: 1,
    maxDepth: 1,
  });
  await spawner.spawn('c');

  // Both calls used to see the guest bound and both cancelled it. `cancel` is
  // not idempotent: the daemon deletes the controller, so the second call
  // re-incarnates the formula — a fresh pet store, mailbox and worker — before
  // cancelling it again.
  const [first, second] = await Promise.allSettled([
    spawner.stop('c'),
    spawner.stop('c'),
  ]);
  t.is(first.status, 'fulfilled');
  t.is(second.status, 'fulfilled');
  t.is(
    cancelled.filter(entry => entry === 'profile-for-p.sub.c-driver-handle')
      .length,
    1,
  );
});
