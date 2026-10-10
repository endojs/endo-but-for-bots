// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { makeWorkflowService } from '@endo/workflow/src/service.js';
import {
  makeFakeAgent,
  makeFakeClock,
  settle,
  // Test-only shared daemon fixture; deliberately not a public package export.
  // eslint-disable-next-line import/no-relative-packages
} from '../../workflow/test/fake-agent.js';

import { endoReleaseChart } from '../deploy-charts.js';
import { make as makeConnection } from '../deploy-connection.js';
import {
  grantDeployFactory,
  provisionMachineAdmin,
} from '../machine-admin-setup.js';

const REV = 'f83f0430cfeb5968563f60f171d58f88d087c1b4';
const PREVIOUS = '59aba752de8ebbbcb485015e9159dcb6d16856e6';

const toPath = nameOrPath =>
  typeof nameOrPath === 'string' ? [nameOrPath] : [...nameOrPath];

// The daemon's `has`, `locate`, and `remove` are varargs of segments, while
// `lookup` (like `EndoHost.lookup`'s `M.call(NameOrPathShape)` guard) takes
// exactly one name-or-path — spreading a path into it throws, which is the
// regression this fake exists to catch.
const varargsPath = args =>
  args.length === 1 && Array.isArray(args[0]) ? [...args[0]] : [...args];
const singlePath = args => {
  if (args.length !== 1) {
    throw Error(`lookup accepts at most 1 arguments, not ${args.length}`);
  }
  return toPath(args[0]);
};

/**
 * A pet store with the surface the setup and the connection use on the
 * connection's powers guest.
 */
const makeStore = () => {
  /** @type {Map<string, any>} */
  const names = new Map();
  const key = path => path.join('/');
  const store = Far('FakeGuest', {
    has: async (...args) => names.has(key(varargsPath(args))),
    lookup: async (...args) => {
      const k = key(singlePath(args));
      if (!names.has(k)) throw Error(`fake-guest: nothing at ${k}`);
      return names.get(k);
    },
    storeValue: async (value, nameOrPath) => {
      names.set(key(toPath(nameOrPath)), value);
    },
    remove: async (...args) => {
      names.delete(key(varargsPath(args)));
    },
  });
  return { store, names };
};

/**
 * The root host the ENDO_EXTRA setups run against, faithful to the parts the
 * grants use: a name tree, locators that resolve to the value bound when
 * they were minted, guest provisioning (including the daemon's trap of
 * handing back the mail handle for a name that already exists), and an
 * unconfined `make` that incarnates the deploy connection over its powers
 * guest the way the daemon would.
 */
// A name the daemon persisted before the formula behind it: bound, but
// nothing resolves.
const DANGLING = harden({ dangling: true });

const makeFakeRoot = () => {
  /** @type {Map<string, any>} */
  const names = new Map();
  /** @type {Map<string, any>} */
  const byLocator = new Map();
  /** @type {Map<string, any>} */
  const guests = new Map();
  const calls = { provideGuest: 0, makeUnconfined: 0 };
  /** @type {Error | undefined} */
  let nextMakeUnconfinedFailure;
  const key = path => path.join('/');
  const agent = Far('FakeRootHost', {
    has: async (...args) => names.has(key(varargsPath(args))),
    lookup: async (...args) => {
      const k = key(singlePath(args));
      if (!names.has(k)) throw Error(`fake-root: nothing at ${k}`);
      const value = names.get(k);
      if (value === DANGLING) throw Error(`No reference exists at path ${k}`);
      return value;
    },
    locate: async (...args) => {
      const k = key(varargsPath(args));
      if (!names.has(k)) throw Error(`fake-root: nothing at ${k}`);
      const locator = `locator:${k}:${byLocator.size}`;
      byLocator.set(locator, names.get(k));
      return locator;
    },
    // A formula id stands in for the bound name; `getFormula` fails for a
    // dangling name the way the daemon fails to read a formula it never
    // wrote.
    identify: async (...args) => {
      const k = key(varargsPath(args));
      if (!names.has(k)) throw Error(`fake-root: nothing at ${k}`);
      return `id:${k}`;
    },
    getFormula: async id => {
      const k = `${id}`.replace(/^id:/, '');
      if (!names.has(k) || names.get(k) === DANGLING) {
        throw Error(`No reference exists at path ${k}`);
      }
      return harden({ type: 'fake' });
    },
    remove: async (...args) => {
      names.delete(key(varargsPath(args)));
    },
    provideGuest: async (handleName, { agentName }) => {
      calls.provideGuest += 1;
      if (names.has(handleName)) {
        // The daemon resolves an existing name to what it holds — the mail
        // handle — not to the guest agent.
        return names.get(handleName);
      }
      const { store } = makeStore();
      guests.set(agentName, store);
      names.set(handleName, Far('FakeHandle', {}));
      names.set(agentName, store);
      return store;
    },
    makeUnconfined: async (
      workerName,
      specifier,
      { powersName, resultName },
    ) => {
      calls.makeUnconfined += 1;
      if (nextMakeUnconfinedFailure !== undefined) {
        const failure = nextMakeUnconfinedFailure;
        nextMakeUnconfinedFailure = undefined;
        throw failure;
      }
      if (workerName !== '@main') throw Error('expected the @main worker');
      if (!specifier.endsWith('/deploy-connection.js')) {
        throw Error(`unexpected caplet module ${specifier}`);
      }
      const powers = names.get(key(toPath(powersName)));
      if (powers === undefined || !guests.has(powers)) {
        if (![...guests.values()].includes(powers)) {
          throw Error(`no guest named ${toPath(powersName).join('/')}`);
        }
      }
      const connection = await makeConnection(powers);
      names.set(key(toPath(resultName)), connection);
    },
    move: async (from, to) => {
      const fromKey = key(toPath(from));
      if (!names.has(fromKey)) throw Error(`fake-root: nothing at ${fromKey}`);
      names.set(key(toPath(to)), names.get(fromKey));
      names.delete(fromKey);
    },
  });
  return {
    agent,
    calls,
    bind: (name, value) => names.set(name, value),
    bindDangling: name => names.set(name, DANGLING),
    unbind: name => names.delete(name),
    has: (...path) => names.has(key(path)),
    get: (...path) => names.get(key(path)),
    resolveLocator: locator => byLocator.get(locator),
    failNextMakeUnconfined: error => {
      nextMakeUnconfinedFailure = error;
    },
  };
};

/** The Floot factory's host profile: what the grants are stored on. */
const makeFactoryHost = () => {
  /** @type {Map<string, string>} */
  const grants = new Map();
  const host = Far('FakeFactoryHost', {
    has: async (...args) => grants.has(varargsPath(args).join('/')),
    remove: async (...args) => {
      grants.delete(varargsPath(args).join('/'));
    },
    storeLocator: async (name, locator) => {
      grants.set(name, locator);
    },
  });
  return { host, grants };
};

/** A settlement-shaped performer that records the engine's trailing keys. */
const makePerformer = () => {
  /** @type {Array<[string, any, string]>} */
  const calls = [];
  const ok = harden({ ok: true, phase: 'ok' });
  const performer = Far('NixosAdmin', {
    stageRev: async (rev, key) => {
      calls.push(['stageRev', rev, key]);
      return harden({ path: 'endo.rev', rev, previous: PREVIOUS });
    },
    prebuildRev: async (rev, key) => {
      calls.push(['prebuildRev', rev, key]);
      return ok;
    },
    build: async (note, key) => {
      calls.push(['build', note, key]);
      return ok;
    },
    apply: async (message, key) => {
      calls.push(['apply', message, key]);
      return ok;
    },
    verify: async (rev, key) => {
      calls.push(['verify', rev, key]);
      return harden({ ok: true, runningRev: rev, phase: 'ok' });
    },
    stageFiles: async (files, key) => {
      calls.push(['stageFiles', files, key]);
      return harden({
        paths: files.map(file => file.path),
        previous: files.map(file => ({ path: file.path, text: null })),
      });
    },
    revertFiles: async (previous, key) => {
      calls.push(['revertFiles', previous, key]);
      return harden({ paths: previous.map(file => file.path) });
    },
    rollback: async key => {
      calls.push(['rollback', undefined, key]);
      return ok;
    },
  });
  return { performer, calls };
};

const provision = (root, factoryHost) =>
  provisionMachineAdmin(root.agent, {
    dir: 'floot',
    factoryHost: factoryHost.host,
  });

test('the grants are quiet no-ops on a daemon without their providers', async t => {
  const root = makeFakeRoot();
  const factoryHost = makeFactoryHost();

  await provision(root, factoryHost);
  t.deepEqual([...factoryHost.grants.keys()], []);
  t.is(root.calls.provideGuest, 0);

  // The caplet alone grants the caplet; the deploy factories need the
  // workflow service as well.
  const { performer } = makePerformer();
  root.bind('controller-for-nixos-admin', performer);
  await provision(root, factoryHost);
  t.deepEqual([...factoryHost.grants.keys()], ['nixos-admin']);
  t.is(root.resolveLocator(factoryHost.grants.get('nixos-admin')), performer);
  t.is(root.calls.provideGuest, 0);

  // A provider that goes away takes its grant with it, so a session opened
  // later fails loudly instead of binding a dangling identity.
  root.unbind('controller-for-nixos-admin');
  await provision(root, factoryHost);
  t.deepEqual([...factoryHost.grants.keys()], []);
});

test('a machine-admin deploy runs through the granted connection', async t => {
  t.timeout(20_000);
  const { powers, controls } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);

  const root = makeFakeRoot();
  const { performer, calls } = makePerformer();
  const operator = Far('OperatorHandle', {});
  const credential = Far('BasicCredential', {
    audience: async () => 'https://forge.example',
  });
  root.bind('workflow-service', h1.service);
  root.bind('controller-for-nixos-admin', performer);
  root.bind('@self', operator);
  root.bind('forgejo-credential', credential);
  const factoryHost = makeFactoryHost();

  await provision(root, factoryHost);

  // Every grant the preset copies is on the factory host, as a locator to
  // the root inventory's own binding.
  t.deepEqual([...factoryHost.grants.keys()].sort(), [
    'change-nixos-factory',
    'deploy-endo-factory',
    'forgejo-credential',
    'nixos-admin',
  ]);
  t.is(root.resolveLocator(factoryHost.grants.get('nixos-admin')), performer);
  t.is(
    root.resolveLocator(factoryHost.grants.get('forgejo-credential')),
    credential,
  );
  // The connections and their guests live under the Floot directory.
  for (const grantName of ['deploy-endo-factory', 'change-nixos-factory']) {
    t.true(root.has('floot', grantName));
    t.true(root.has('floot', `${grantName}-powers`));
    t.true(root.has('floot', `${grantName}-handle`));
    t.false(root.has(`floot-${grantName}-handle`));
    t.false(root.has(`profile-for-floot-${grantName}-handle`));
  }
  t.is(root.calls.provideGuest, 2);
  t.is(root.calls.makeUnconfined, 2);
  t.deepEqual(
    (await E(h1.service).charts()).map(({ name, version }) => [name, version]),
    [
      ['endo-release', 2],
      ['nixos-config-change', 1],
    ],
  );

  // A session's copy of the grant is the connection, and describes the
  // factory it proposes runs through.
  const connection = root.resolveLocator(
    factoryHost.grants.get('deploy-endo-factory'),
  );
  const described = await E(connection).describe();
  t.like(described, {
    chartName: 'endo-release',
    chartVersion: 2,
    revoked: false,
    endowmentNames: ['operator', 'performer'],
  });
  const firstFid = described.fid;

  // A re-run (every boot) keeps the guest and its factory, and re-creates
  // the connection caplet against the current release behind the same grant
  // name — a session re-copies it on revival.
  await provision(root, factoryHost);
  t.is(root.calls.provideGuest, 2);
  t.is(root.calls.makeUnconfined, 4);
  const rebuilt = root.resolveLocator(
    factoryHost.grants.get('deploy-endo-factory'),
  );
  t.not(rebuilt, connection);
  t.is((await E(rebuilt).describe()).fid, firstFid);

  // Propose a deployment. Any endowment a caller attaches is dropped: the
  // run holds exactly what the factory bound.
  const { runId } = await E(rebuilt).start(
    harden({
      params: {
        title: 'fix(floot): raise the tool-step ceiling',
        summary: 'One-line change to the agent loop; tests pass.',
        rev: REV,
        branch: 'agent',
      },
      endowments: { stray: Far('Stray', {}) },
    }),
  );
  await settle(300);
  const waiting = await E(rebuilt).status(runId);
  t.is(waiting.configuration.state, 'await-approval');
  t.false(waiting.done);
  t.is(waiting.factory, firstFid);
  const [started] = await E(rebuilt).journal(runId, { from: 0n, to: 1n });
  t.is(started.kind, 'started');
  t.deepEqual(started.endowmentNames, ['operator', 'performer']);
  t.is(started.factory, firstFid);
  // The performer saw the pre-approval half, keyed by the run.
  t.deepEqual(
    calls.map(([method]) => method),
    ['stageRev', 'prebuildRev', 'build'],
  );
  t.true(calls.every(([, , key]) => key.startsWith(`${runId}:`)));
  // The approval form went to the operator, not to the proposer.
  const form = controls.findMessage('form', 'Deploy Endo');
  t.truthy(form);
  t.true(form.description.includes(REV));
  t.truthy(await E(rebuilt).explain(runId));
  // The previous incarnation of the connection observes the same run.
  t.is(
    (await E(connection).status(runId)).configuration.state,
    'await-approval',
  );

  await controls.submitForm(form, harden({ approved: true, note: '' }));
  await settle(300);
  const landed = await E(rebuilt).status(runId);
  t.true(landed.done);
  t.is(landed.outcome, 'completed');
  t.is(landed.configuration.state, 'done');
  t.deepEqual(
    calls.map(([method]) => method),
    ['stageRev', 'prebuildRev', 'build', 'apply', 'verify'],
  );

  // Observation is scoped to this connection's own factories.
  const foreign = await E(h1.service).start(
    harden({
      name: 'foreign',
      version: 1,
      initial: 'wait',
      states: {
        wait: { on: { go: [{ target: 'done' }] } },
        done: { final: true },
      },
    }),
    harden({ params: {} }),
  );
  await t.throwsAsync(E(rebuilt).status(foreign.runId), {
    message: /another factory/,
  });

  // A chart version bump re-mints the factory behind the same connection,
  // leaves the old factory un-revoked, and keeps its runs observable.
  const bumped = harden({
    ...endoReleaseChart,
    version: endoReleaseChart.version + 1,
  });
  await grantDeployFactory(root.agent, {
    dir: 'floot',
    factoryHost: factoryHost.host,
    service: h1.service,
    endowments: harden({ performer, operator }),
    chart: bumped,
    grantName: 'deploy-endo-factory',
  });
  const latest = root.resolveLocator(
    factoryHost.grants.get('deploy-endo-factory'),
  );
  const after = await E(latest).describe();
  t.is(after.chartVersion, endoReleaseChart.version + 1);
  t.not(after.fid, firstFid);
  t.is((await E(E(h1.service).factory(firstFid)).describe()).revoked, false);
  t.true((await E(latest).status(runId)).done);
  t.is(root.calls.provideGuest, 2);
});

test('a crash between minting the powers guest and tucking it away heals on the next run', async t => {
  const { powers } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);

  const root = makeFakeRoot();
  const { performer } = makePerformer();
  root.bind('workflow-service', h1.service);
  root.bind('controller-for-nixos-admin', performer);
  root.bind('@self', Far('OperatorHandle', {}));
  const factoryHost = makeFactoryHost();

  // The first run dies after the guest exists but before the connection is
  // made and the guest is moved under floot/: its top-level names remain.
  root.failNextMakeUnconfined(Error('simulated crash before the move'));
  await provision(root, factoryHost);
  t.true(root.has('floot-deploy-endo-factory-handle'));
  t.true(root.has('profile-for-floot-deploy-endo-factory-handle'));
  t.false(root.has('floot', 'deploy-endo-factory'));
  t.false(factoryHost.grants.has('deploy-endo-factory'));
  // The other grant is unaffected by the first one's failure.
  t.true(factoryHost.grants.has('change-nixos-factory'));
  const orphanedGuest = root.get(
    'profile-for-floot-deploy-endo-factory-handle',
  );
  const fidsBefore = await E(orphanedGuest).lookup('factory-ids');
  t.is(fidsBefore.length, 1);

  // The next run adopts the existing guest by its agent name rather than
  // asking provideGuest again (which would hand back the mail handle),
  // keeps its factory, makes the connection, and completes the move.
  await provision(root, factoryHost);
  t.is(root.calls.provideGuest, 2);
  t.false(root.has('floot-deploy-endo-factory-handle'));
  t.false(root.has('profile-for-floot-deploy-endo-factory-handle'));
  t.true(root.has('floot', 'deploy-endo-factory'));
  t.is(root.get('floot', 'deploy-endo-factory-powers'), orphanedGuest);
  const connection = root.resolveLocator(
    factoryHost.grants.get('deploy-endo-factory'),
  );
  t.is((await E(connection).describe()).fid, fidsBefore[0]);
  t.deepEqual(await E(orphanedGuest).lookup('factory-ids'), fidsBefore);
});

test('stray names from a crash inside guest provisioning are cleared before minting', async t => {
  const { powers } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);

  const root = makeFakeRoot();
  const { performer } = makePerformer();
  root.bind('workflow-service', h1.service);
  root.bind('controller-for-nixos-admin', performer);
  root.bind('@self', Far('OperatorHandle', {}));
  // A handle name with nothing behind it: `provideGuest` would hand it back
  // instead of minting.
  const stray = Far('StrayHandle', {});
  root.bind('floot-deploy-endo-factory-handle', stray);
  // An agent name whose formula was never persisted: nothing resolves it.
  root.bindDangling('profile-for-floot-change-nixos-factory-handle');
  const factoryHost = makeFactoryHost();

  await provision(root, factoryHost);

  t.is(root.calls.provideGuest, 2);
  for (const grantName of ['deploy-endo-factory', 'change-nixos-factory']) {
    t.true(factoryHost.grants.has(grantName));
    t.true(root.has('floot', grantName));
    t.true(root.has('floot', `${grantName}-powers`));
    t.not(root.get('floot', `${grantName}-handle`), stray);
    t.false(root.has(`floot-${grantName}-handle`));
    t.false(root.has(`profile-for-floot-${grantName}-handle`));
  }
});

test('a transient service failure skips the grant for one boot instead of minting a duplicate', async t => {
  const { powers } = makeFakeAgent();
  const clock = makeFakeClock();
  const h1 = await makeWorkflowService({ powers, clock });
  t.teardown(h1.stop);

  let hiccup = false;
  const service = Far('FlakyWorkflowService', {
    install: chart => E(h1.service).install(chart),
    makeFactory: options => E(h1.service).makeFactory(options),
    factory: fid => {
      if (hiccup) {
        hiccup = false;
        throw Error('transport hiccup');
      }
      return E(h1.service).factory(fid);
    },
    run: runId => E(h1.service).run(runId),
    charts: () => E(h1.service).charts(),
  });
  const root = makeFakeRoot();
  const { performer } = makePerformer();
  root.bind('workflow-service', service);
  root.bind('controller-for-nixos-admin', performer);
  root.bind('@self', Far('OperatorHandle', {}));
  const factoryHost = makeFactoryHost();

  await provision(root, factoryHost);
  const connection = root.resolveLocator(
    factoryHost.grants.get('deploy-endo-factory'),
  );
  const { fid } = await E(connection).describe();
  const guest = root.get('floot', 'deploy-endo-factory-powers');

  // The factory check fails for a reason other than "no such factory": the
  // grant is skipped this boot, the previous connection stays granted, and
  // no second factory is minted behind the same connection.
  hiccup = true;
  await provision(root, factoryHost);
  t.deepEqual(await E(guest).lookup('factory-ids'), [fid]);
  t.is(
    root.resolveLocator(factoryHost.grants.get('deploy-endo-factory')),
    connection,
  );

  // The next boot re-binds as usual, still over the one factory.
  await provision(root, factoryHost);
  t.deepEqual(await E(guest).lookup('factory-ids'), [fid]);
  t.not(
    root.resolveLocator(factoryHost.grants.get('deploy-endo-factory')),
    connection,
  );
});
