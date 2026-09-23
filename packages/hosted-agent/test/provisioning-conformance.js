// @ts-check
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { Far } from '@endo/far';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeBackendCatalog } from '../src/backend-catalog.js';
import {
  HostedToolSetInterface,
  assertHostedBackendDescriptor,
} from '../src/hosted-backend.js';

/**
 * Shared provisioning conformance for the hosted CLI adapters.
 *
 * Every adapter declares its own plan fields, private paths, immutable and
 * rebindable fields and pin policy over the one session provisioner and the one backend
 * factory (`session-provisioner.js`, `backend-factory-kit.js`). These are the
 * lifecycle properties that hold whatever the runtime is: what a record is
 * created with, what a reopen keeps and refuses, what a partial acquisition
 * leaves behind, how a failed stop is retained, and what deletion does. An
 * adapter's own suite adds what its runtime needs.
 *
 * @param {object} adapter
 * @param {string} adapter.label
 * @param {(powers: { owner: any, dependencies: Record<string, string>, workspaceRoot: string, privateRoot: string, protectedRoots: readonly string[], catalog: ReturnType<typeof makeBackendCatalog> }) => (sessionId: string, request: Record<string, any>, toolSet: any) => Promise<any>} adapter.makeProvisioner
 *   The adapter's declaration over the shared provisioner.
 * @param {(powers: { provisionSession: any, stopSession: any, removeSession: any, catalog: any, publicInternetEnabled?: boolean, listSubscriptions?: any }) => any} adapter.makeFactory
 *   The adapter's declaration over the shared factory.
 * @param {Record<string, any>} [adapter.request] Request fields the
 *   adapter's plan needs beyond the shared ones (Codex's container mounts).
 * @param {Array<{ what: string, makeProvisioner: (powers: any) => (sessionId: string, request: Record<string, any>, toolSet: any) => Promise<any> }>} [adapter.rebound]
 *   The same declaration over a broker re-minted with another binding a
 *   record follows only under a request that authorizes it: another image,
 *   credential kind or account, named as the refusal and the authorization
 *   name it.
 */
export const testProvisioningConformance = ({
  label,
  makeProvisioner,
  makeFactory,
  request: extraRequest = {},
  rebound = [],
}) => {
  const model = 'model-a';

  /** What one account lists; `answer` scripts an outage. */
  const scriptedCatalog = () => {
    const state = { answer: true };
    const catalog = makeBackendCatalog({
      label,
      readCatalog: async () => {
        if (!state.answer) throw Error('provider catalog down');
        return harden({
          accounts: [
            {
              subscriptionId: 'default',
              state: 'current',
              observedAt: 1,
              models: [
                {
                  id: model,
                  title: 'Model A',
                  description: '',
                  default: true,
                  defaultReasoningEffort: 'low',
                  reasoningEfforts: ['low', 'high'],
                },
              ],
            },
          ],
        });
      },
    });
    return { catalog, state };
  };

  /** A recording stand-in for the daemon's session owner. */
  const makeFakeOwner = () => {
    /** @type {Map<string, { plan: string | undefined, references: Record<string, string>, phase: string }>} */
    const records = new Map();
    /** @type {any[][]} */
    const log = [];
    /** @type {{ startError: Error | undefined, reviseError: Error | undefined }} */
    const knobs = { startError: undefined, reviseError: undefined };
    // The owner's forwarding facet, as a factory's run facet drives it.
    const client = Far('Client', {
      async send() {
        return harden({});
      },
      async interrupt() {
        await null;
      },
      async status() {
        return harden({});
      },
      async models() {
        return harden([]);
      },
      async acknowledge() {
        await null;
      },
    });
    const owner = Far('Owner', {
      async create(name, plan, references) {
        log.push(['create', name, plan, references]);
        records.set(name, {
          plan,
          references: { ...references },
          phase: 'planned',
        });
      },
      async inspect(name) {
        log.push(['inspect', name]);
        const record = records.get(name);
        return record === undefined ? undefined : harden({ ...record });
      },
      /**
       * @param {string} name
       * @param {string} plan
       * @param {Record<string, string>} [references]
       */
      async revise(name, plan, references = undefined) {
        log.push(
          references === undefined
            ? ['revise', name, plan]
            : ['revise', name, plan, references],
        );
        if (knobs.reviseError) throw knobs.reviseError;
        const record = records.get(name);
        if (!record) throw Error('missing record');
        if (references !== undefined) {
          record.references = { ...record.references, ...references };
        }
        record.plan = plan;
      },
      async start(name, tools) {
        log.push(['start', name, tools]);
        if (knobs.startError) throw knobs.startError;
        const record = records.get(name);
        if (!record) throw Error('missing record');
        record.phase = 'ready';
        return client;
      },
      async stop(name) {
        log.push(['stop', name]);
        const record = records.get(name);
        if (record) record.phase = 'stopped';
      },
      async remove(name) {
        log.push(['remove', name]);
        records.delete(name);
      },
    });
    return { owner, records, log, knobs, client };
  };

  /** @param {import('ava').ExecutionContext} t */
  const fixture = async t => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'provisioning-conformance-')),
    );
    t.teardown(() => rm(base, { recursive: true, force: true }));
    const workspaceRoot = join(base, 'workspaces');
    const privateRoot = join(base, 'private');
    const protectedRoot = join(base, 'state');
    await mkdir(join(protectedRoot, 'records'), { recursive: true });
    const { owner, records, log, knobs, client } = makeFakeOwner();
    const scripted = scriptedCatalog();
    const dependencies = harden({
      sandboxService: 'sandbox-id',
      brokerService: 'broker-id',
      stateProvider: 'state-id',
      storage: 'storage-id',
    });
    const provision = makeProvisioner({
      owner,
      dependencies,
      workspaceRoot,
      privateRoot,
      protectedRoots: harden([protectedRoot]),
      catalog: scripted.catalog,
    });
    const request = harden({ networkPolicy: 'off', model, ...extraRequest });
    const tools = Far('Tools', {});
    const exists = directory =>
      access(directory).then(
        () => true,
        () => false,
      );
    const plan = id => JSON.parse(records.get(id)?.plan ?? 'null');
    const names = () => log.map(entry => entry[0]);
    return {
      base,
      workspaceRoot,
      privateRoot,
      protectedRoot,
      owner,
      records,
      log,
      knobs,
      client,
      scripted,
      dependencies,
      provision,
      request,
      tools,
      exists,
      plan,
      names,
    };
  };

  test(`${label} provisioning records the plan with its exact dependencies, creates the recorded directories, then starts`, async t => {
    const f = await fixture(t);
    // A refused pin records nothing.
    await t.throwsAsync(
      f.provision('a', { ...f.request, model: 'model-z' }, f.tools),
      { message: /Unknown/ },
    );
    t.false(f.names().includes('create'));
    t.is(await f.provision('a', f.request, f.tools), f.client);
    t.deepEqual(f.names().slice(-3), ['inspect', 'create', 'start']);
    const [, name, , references] =
      f.log.find(([kind]) => kind === 'create') ?? [];
    t.is(name, 'a');
    t.deepEqual(references, f.dependencies);
    const plan = f.plan('a');
    t.is(plan.sessionId, 'a');
    t.is(plan.workspaceDir, join(f.workspaceRoot, plan.sandboxSessionId));
    t.is(
      plan.workspaceMountPoint,
      join(f.privateRoot, plan.sandboxSessionId, 'workspace'),
    );
    t.is(
      plan.mounterSocketDir,
      join(f.privateRoot, plan.sandboxSessionId, '9p'),
    );
    t.like(plan, { networkPolicy: 'off', model, reasoningEffort: 'low' });
    for (const directory of [
      join(f.privateRoot, plan.sandboxSessionId),
      plan.mounterSocketDir,
      plan.workspaceDir,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      t.true(await f.exists(directory), directory);
    }
    t.false(
      await f.exists(plan.workspaceMountPoint),
      'the mount point is the mounter’s to create',
    );
  });

  test(`${label} a reopen keeps the recorded pin through a catalog outage; a changed pin is refused then and admitted after`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    f.scripted.state.answer = false;
    // Floot's reopen names the persisted pin, or its empty spelling; either
    // keeps the record without asking the provider.
    for (const spec of [
      { model, reasoningEffort: 'low' },
      { model: '', reasoningEffort: '' },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await f.provision('a', { ...f.request, ...spec }, f.tools);
      t.deepEqual(f.names().slice(-3), ['inspect', 'stop', 'start']);
      t.like(f.plan('a'), { model, reasoningEffort: 'low' });
    }
    // A changed pin, or a new session, is a new pin: refused while the
    // catalog cannot be read, and no other model is put in its place.
    await t.throwsAsync(
      f.provision('a', { ...f.request, reasoningEffort: 'high' }, f.tools),
      { message: /model catalog is unavailable/ },
    );
    await t.throwsAsync(f.provision('b', f.request, f.tools), {
      message: /model catalog is unavailable/,
    });
    t.false(f.records.has('b'));
    t.like(f.plan('a'), { model, reasoningEffort: 'low' });
    f.scripted.state.answer = true;
    await f.provision('a', { ...f.request, reasoningEffort: 'high' }, f.tools);
    t.deepEqual(f.names().slice(-4), ['inspect', 'stop', 'revise', 'start']);
    t.like(f.plan('a'), { model, reasoningEffort: 'high' });
    // An effort changed on its own keeps the recorded model.
    const { model: _named, ...unnamed } = f.request;
    await f.provision('a', { ...unnamed, reasoningEffort: 'low' }, f.tools);
    t.like(f.plan('a'), { model, reasoningEffort: 'low' });
    t.is(f.names().filter(kind => kind === 'create').length, 1);
  });

  test(`${label} placement cannot change on reopen: the record is untouched and nothing is stopped`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    const foreign = join(f.base, 'foreign');
    await mkdir(foreign);
    const before = f.log.length;
    await t.throwsAsync(
      f.provision('a', { ...f.request, workspaceHostPath: foreign }, f.tools),
      { message: /workspace cannot change; destroy the session first/ },
    );
    t.deepEqual(f.names().slice(before), ['inspect']);
    t.true('workspaceDir' in f.plan('a'));
    t.is(f.records.get('a')?.phase, 'ready');
  });

  test(`${label} an operator workspace must be an existing canonical directory disjoint from every root`, async t => {
    const f = await fixture(t);
    const create = workspaceHostPath =>
      f.provision('b', { ...f.request, workspaceHostPath }, f.tools);
    await t.throwsAsync(create(join(f.base, 'missing')), {
      message: /must be an existing directory/,
    });
    const target = join(f.base, 'target');
    await mkdir(target);
    await symlink(target, join(f.base, 'link'));
    await t.throwsAsync(create(join(f.base, 'link')), {
      message: /must be an existing directory/,
    });
    // `<base>/alias` -> `<base>`: the spelling clears the string check while
    // the directory is one session's owned workspace under the workspace
    // root.
    await symlink(f.base, join(f.base, 'alias'));
    await mkdir(join(f.workspaceRoot, 'victim'), { recursive: true });
    await t.throwsAsync(create(join(f.base, 'alias', 'workspaces', 'victim')), {
      message: /must be a canonical path; it resolves to/,
    });
    for (const inside of [
      f.workspaceRoot,
      join(f.privateRoot, 'x'),
      f.protectedRoot,
      join(f.protectedRoot, 'records'),
      f.base,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(create(inside), {
        message: /must be disjoint from the session storage roots/,
      });
    }
    for (const spelling of ['/', `${f.base}/`, 'relative']) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(create(spelling), {
        message: /must be a normalized absolute path/,
      });
    }
    t.false(f.names().includes('create'), 'nothing was recorded');
  });

  test(`${label} a guest root that resolves into protected storage is refused before any owner mutation`, async t => {
    const f = await fixture(t);
    // An alias above a fresh session leaf must not turn owned workspace
    // allocation into host-record allocation.
    await symlink(f.protectedRoot, f.workspaceRoot);
    await t.throwsAsync(f.provision('a', f.request, f.tools), {
      message: /guest storage overlaps protected session storage/,
    });
    t.deepEqual(f.names(), ['inspect']);
    t.false(f.records.has('a'));
  });

  test(`${label} a start that fails leaves the record for retry through its own cleanup`, async t => {
    const f = await fixture(t);
    f.knobs.startError = Error('slice refused');
    await t.throwsAsync(f.provision('a', f.request, f.tools), {
      message: /slice refused/,
    });
    t.is(f.records.get('a')?.phase, 'planned', 'the record stays');
    t.deepEqual(f.names(), ['inspect', 'create', 'start']);
    f.knobs.startError = undefined;
    t.is(await f.provision('a', f.request, f.tools), f.client);
    // Stopped before reuse whatever the phase; the unchanged plan needs no
    // revision.
    t.deepEqual(f.names().slice(3), ['inspect', 'stop', 'start']);
    t.is(f.records.get('a')?.phase, 'ready');
  });

  test(`${label} an incomplete record is refused until it is destroyed`, async t => {
    const f = await fixture(t);
    f.records.set('a', { plan: undefined, references: {}, phase: 'planned' });
    await t.throwsAsync(f.provision('a', f.request, f.tools), {
      message: /incomplete record; destroy it before reuse/,
    });
    t.deepEqual(f.names(), ['inspect']);
  });

  test(`${label} recorded directories heal on the next start; the mount point stays the mounter’s`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    const plan = f.plan('a');
    await rm(plan.mounterSocketDir, { recursive: true, force: true });
    await rm(plan.workspaceDir, { recursive: true, force: true });
    await f.provision('a', f.request, f.tools);
    t.true(await f.exists(plan.mounterSocketDir), 'socket directory recreated');
    t.true(await f.exists(plan.workspaceDir), 'owned workspace recreated');
    t.false(await f.exists(plan.workspaceMountPoint));
    t.is(f.names().filter(kind => kind === 'create').length, 1);
  });

  test(`${label} the network policy and the subscription may change between incarnations; the pin is kept`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    await f.provision(
      'a',
      {
        ...f.request,
        networkPolicy: 'public-internet',
        subscription: 'default',
      },
      f.tools,
    );
    t.deepEqual(f.names().slice(-4), ['inspect', 'stop', 'revise', 'start']);
    t.like(f.plan('a'), {
      networkPolicy: 'public-internet',
      subscription: 'default',
      model,
    });
    await f.provision('a', f.request, f.tools);
    t.false('subscription' in f.plan('a'));
    t.is(f.plan('a').networkPolicy, 'off');
    t.is(f.records.size, 1);
  });

  test(`${label} a revision that fails leaves the stopped record with its previous plan for retry`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    f.knobs.reviseError = Error('record store refused');
    await t.throwsAsync(
      f.provision('a', { ...f.request, systemPrompt: 'persona' }, f.tools),
      { message: /record store refused/ },
    );
    t.deepEqual(f.names().slice(-3), ['inspect', 'stop', 'revise']);
    t.false('systemPrompt' in f.plan('a'), 'the previous plan stands');
    t.is(f.records.get('a')?.phase, 'stopped');
    f.knobs.reviseError = undefined;
    await f.provision('a', { ...f.request, systemPrompt: 'persona' }, f.tools);
    t.deepEqual(f.names().slice(-4), ['inspect', 'stop', 'revise', 'start']);
    t.is(f.plan('a').systemPrompt, 'persona');
  });

  for (const { what, makeProvisioner: makeRebound } of rebound) {
    test(`${label} a record reopened under a broker with another ${what} is refused until a request authorizes the rebind, which revises after a stop`, async t => {
      const f = await fixture(t);
      await f.provision('a', f.request, f.tools);
      const other = makeRebound({
        owner: f.owner,
        dependencies: f.dependencies,
        workspaceRoot: f.workspaceRoot,
        privateRoot: f.privateRoot,
        protectedRoots: harden([f.protectedRoot]),
        catalog: f.scripted.catalog,
      });
      const before = f.log.length;
      await t.throwsAsync(other('a', f.request, f.tools), {
        message: new RegExp(
          `${what} cannot change without a reopen that authorizes rebinding it`,
        ),
      });
      // Authorizing another binding is not authorizing this one, and a
      // binding this adapter does not know is refused, not ignored.
      await t.throwsAsync(
        other('a', { ...f.request, rebind: ['provider'] }, f.tools),
        { message: new RegExp(`${what} cannot change`) },
      );
      await t.throwsAsync(
        other('a', { ...f.request, rebind: ['persona'] }, f.tools),
        { message: /cannot rebind "persona"/ },
      );
      t.deepEqual(f.names().slice(before), ['inspect', 'inspect', 'inspect']);
      t.is(f.records.get('a')?.phase, 'ready');
      const recordedBefore = f.plan('a');
      t.is(
        await other('a', { ...f.request, rebind: [what] }, f.tools),
        f.client,
      );
      t.deepEqual(f.names().slice(-4), ['inspect', 'stop', 'revise', 'start']);
      const revise = f.log.findLast(([kind]) => kind === 'revise');
      t.is(revise?.length, 3, 'the dependencies are unchanged, none rebound');
      const revised = f.plan('a');
      t.notDeepEqual(revised, recordedBefore);
      t.is(f.records.size, 1);
      // Rebound, the record answers the rebound broker without a further
      // authorization and refuses the one it was created under.
      await other('a', f.request, f.tools);
      t.deepEqual(f.names().slice(-3), ['inspect', 'stop', 'start']);
      t.deepEqual(f.plan('a'), revised);
      await t.throwsAsync(f.provision('a', f.request, f.tools), {
        message: new RegExp(`${what} cannot change`),
      });
    });
  }

  test(`${label} a record reopened under other services rebinds its dependencies only when authorized, after a stop; a failed revision leaves the old binding`, async t => {
    const f = await fixture(t);
    await f.provision('a', f.request, f.tools);
    const planBefore = f.plan('a');
    const dependencies = harden({
      ...f.dependencies,
      brokerService: 'broker-2',
    });
    const other = makeProvisioner({
      owner: f.owner,
      dependencies,
      workspaceRoot: f.workspaceRoot,
      privateRoot: f.privateRoot,
      protectedRoots: harden([f.protectedRoot]),
      catalog: f.scripted.catalog,
    });
    const before = f.log.length;
    await t.throwsAsync(other('a', f.request, f.tools), {
      message:
        /provider cannot change without a reopen that authorizes rebinding it/,
    });
    t.deepEqual(f.names().slice(before), ['inspect']);
    t.deepEqual(f.records.get('a')?.references, f.dependencies);
    f.knobs.reviseError = Error('record store refused');
    await t.throwsAsync(
      other('a', { ...f.request, rebind: ['provider'] }, f.tools),
      { message: /record store refused/ },
    );
    t.deepEqual(f.names().slice(-3), ['inspect', 'stop', 'revise']);
    t.deepEqual(
      f.records.get('a')?.references,
      f.dependencies,
      'the old binding stands',
    );
    t.is(f.records.get('a')?.phase, 'stopped');
    f.knobs.reviseError = undefined;
    t.is(
      await other('a', { ...f.request, rebind: ['provider'] }, f.tools),
      f.client,
    );
    t.deepEqual(f.names().slice(-4), ['inspect', 'stop', 'revise', 'start']);
    const revise = f.log.findLast(([kind]) => kind === 'revise');
    t.deepEqual(revise?.[3], dependencies);
    t.deepEqual(f.records.get('a')?.references, dependencies);
    t.deepEqual(f.plan('a'), planBefore, 'the plan is untouched by it');
    // Rebound, the record answers the rebound services without a further
    // authorization.
    await other('a', f.request, f.tools);
    t.deepEqual(f.names().slice(-3), ['inspect', 'stop', 'start']);
    // A new session takes no authorization: there is nothing to rebind.
    await t.throwsAsync(
      other('b', { ...f.request, rebind: ['provider'] }, f.tools),
      { message: /has no record to rebind/ },
    );
    t.false(f.records.has('b'));
  });

  const makeToolSet = () =>
    makeExo('HostedToolSet', HostedToolSetInterface, {
      async describe() {
        return harden({ dynamicTools: [], toolSetId: 'tools-v1' });
      },
      async execute() {
        return 'ok';
      },
      help: () => 'test tool set',
    });

  /** The factory over recording owner powers; a stop can be made to fail. */
  const makeHarness = ({ publicInternetEnabled = true } = {}) => {
    /** @type {any[][]} */
    const log = [];
    /** @type {string | undefined} */
    let failingStop;
    let provisionFails = false;
    const client = Far('Client', {
      async send() {
        return harden({});
      },
      async interrupt() {
        await null;
      },
      async status() {
        return harden({});
      },
      async models() {
        return harden([]);
      },
      async acknowledge() {
        await null;
      },
    });
    const factory = makeFactory({
      catalog: scriptedCatalog().catalog,
      publicInternetEnabled,
      listSubscriptions: async () => harden([{ id: 'work', label: 'Work' }]),
      provisionSession: async (sessionId, request, toolSet) => {
        log.push(['provision', sessionId, request, toolSet]);
        if (provisionFails) throw Error('owner refused the plan');
        return client;
      },
      stopSession: async sessionId => {
        log.push(['stop', sessionId]);
        if (sessionId === failingStop) throw Error('native cleanup pending');
      },
      removeSession: async sessionId => {
        log.push(['remove', sessionId]);
      },
    });
    return {
      factory,
      log,
      names: () => log.map(entry => entry[0]),
      failStop: sessionId => {
        failingStop = sessionId;
      },
      failProvision: value => {
        provisionFails = value;
      },
    };
  };

  test(`${label} describe presents a hosted backend with the broker's network authority`, async t => {
    const descriptor = await E(makeHarness().factory).describe();
    assertHostedBackendDescriptor(descriptor);
    t.like(descriptor, { kind: 'hosted', toolOwnership: 'endo' });
    t.deepEqual(descriptor.supportedNetworkPolicies, [
      'off',
      'public-internet',
    ]);
    t.deepEqual(
      (
        await E(
          makeHarness({ publicInternetEnabled: false }).factory,
        ).describe()
      ).supportedNetworkPolicies,
      ['off'],
    );
  });

  test(`${label} create validates the request before stopping a predecessor and hands it to the provisioner with the tool set`, async t => {
    const { factory, log, names } = makeHarness();
    const toolSet = makeToolSet();
    const { run, admin } = await E(factory).create(
      harden({
        sessionId: 'session-a',
        networkPolicy: 'public-internet',
        systemPrompt: 'persona',
        workspaceHostPath: '/srv/worktree',
      }),
      toolSet,
    );
    t.like(log[0][2], {
      networkPolicy: 'public-internet',
      systemPrompt: 'persona',
      workspaceHostPath: '/srv/worktree',
    });
    t.is(log[0][3], toolSet);
    t.deepEqual(await E(run).status(), {});
    await E(admin).terminate();
    /** @type {[Record<string, any>, RegExp][]} */
    const refused = [
      [{ sessionId: '../x' }, /bounded lowercase path component/],
      [
        { sessionId: 'session-b', networkPolicy: 'host' },
        /Unknown network policy/,
      ],
      [{ sessionId: 'session-b', model: 'x'.repeat(257) }, /bounded string/],
      [
        { sessionId: 'session-b', workspaceHostPath: 'relative' },
        /normalized absolute host path/,
      ],
      [{ sessionId: 'session-b', subscription: 'nope' }, /subscription/],
    ];
    const before = names().length;
    for (const [spec, message] of refused) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(E(factory).create(harden(spec), makeToolSet()), {
        message,
      });
    }
    t.is(names().length, before, 'refused before any stop or provision');
    const brokerOnly = makeHarness({ publicInternetEnabled: false });
    await t.throwsAsync(
      E(brokerOnly.factory).create(
        harden({ sessionId: 'session-a', networkPolicy: 'public-internet' }),
        makeToolSet(),
      ),
      { message: /does not permit public internet access/ },
    );
    t.deepEqual(brokerOnly.names(), []);
  });

  test(`${label} terminate stops once through the owner and a second create stops the first`, async t => {
    const { factory, names } = makeHarness();
    const { admin } = await E(factory).create(
      harden({ sessionId: 'session-a' }),
      makeToolSet(),
    );
    await E(admin).terminate();
    await E(admin).terminate();
    t.deepEqual(names(), ['provision', 'stop']);
    await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
    await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
    t.deepEqual(names(), [
      'provision',
      'stop',
      'provision',
      'stop',
      'provision',
    ]);
  });

  test(`${label} a failed stop is retained: successors and deletion refuse until it succeeds`, async t => {
    const { factory, names, failStop } = makeHarness();
    const { admin } = await E(factory).create(
      harden({ sessionId: 'session-a' }),
      makeToolSet(),
    );
    failStop('session-a');
    await t.throwsAsync(E(admin).terminate(), {
      message: /native cleanup pending/,
    });
    await t.throwsAsync(
      E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
      { message: /native cleanup pending/ },
    );
    await t.throwsAsync(
      E(factory).destroy(harden({ sessionId: 'session-a' })),
      {
        message: /native cleanup pending/,
      },
    );
    // An unrelated session is unaffected.
    await E(factory).create(harden({ sessionId: 'session-b' }), makeToolSet());
    failStop(undefined);
    await E(admin).terminate();
    t.deepEqual(names(), [
      'provision',
      'stop',
      'stop',
      'stop',
      'provision',
      'stop',
    ]);
  });

  test(`${label} factory stop reaches an unretained owner and preserves state on retry`, async t => {
    const { factory, names, failStop } = makeHarness();
    const spec = harden({ sessionId: 'session-a' });
    failStop('session-a');
    await t.throwsAsync(E(factory).stop(spec), {
      message: /native cleanup pending/,
    });
    t.deepEqual(names(), ['stop'], 'no create or removal for an absent admin');
    failStop(undefined);
    await E(factory).stop(spec);
    const { admin } = await E(factory).create(spec, makeToolSet());
    await E(factory).stop(spec);
    await E(admin).terminate();
    t.deepEqual(names(), ['stop', 'stop', 'provision', 'stop']);
    await E(factory).create(spec, makeToolSet());
    t.is(names().at(-1), 'provision', 'a completed stop permits restart');
    t.false(names().includes('remove'));
  });

  test(`${label} destroy stops a live session, then asks the owner to remove it; it is idempotent`, async t => {
    const { factory, names } = makeHarness();
    await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
    await E(factory).destroy(harden({ sessionId: 'session-a' }));
    await E(factory).destroy(harden({ sessionId: 'session-a' }));
    t.deepEqual(names(), ['provision', 'stop', 'remove', 'remove']);
  });

  test(`${label} the factory over the provisioner drives the owner end to end: create, reopen, destroy`, async t => {
    const f = await fixture(t);
    const factory = makeFactory({
      catalog: f.scripted.catalog,
      publicInternetEnabled: true,
      provisionSession: f.provision,
      stopSession: id => E(f.owner).stop(id),
      removeSession: id => E(f.owner).remove(id),
    });
    const spec = harden({ sessionId: 'session-a', model });
    const { run } = await E(factory).create(spec, makeToolSet());
    t.deepEqual(f.names(), ['inspect', 'create', 'start']);
    t.like(f.plan('session-a'), { sessionId: 'session-a', model });
    t.deepEqual(await E(run).status(), {});
    // A reopen stops the retained incarnation, then the owner's stop again
    // before the revised plan starts.
    // What a reopen may be authorized to rebind is the same vocabulary for
    // every backend: the image, the account authority, the services.
    t.deepEqual((await E(factory).describe()).rebindableBindings, [
      'image',
      'account',
      'provider',
    ]);
    await E(factory).create(
      harden({ ...spec, systemPrompt: 'persona' }),
      makeToolSet(),
    );
    t.deepEqual(f.names().slice(3), [
      'stop',
      'inspect',
      'stop',
      'revise',
      'start',
    ]);
    t.is(f.plan('session-a').systemPrompt, 'persona');
    await E(factory).destroy(spec);
    t.deepEqual(f.names().slice(8), ['stop', 'remove']);
    t.false(f.records.has('session-a'));
    await E(factory).destroy(spec);
    t.deepEqual(f.names().slice(10), ['remove']);
  });

  test(`${label} the factory refuses a rebind list of the wrong shape before provisioning`, async t => {
    const { factory, names } = makeHarness();
    for (const rebind of [
      'image',
      ['image', ''],
      ['x'.repeat(65)],
      Array.from({ length: 9 }, () => 'image'),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        E(factory).create(
          harden({ sessionId: 'session-a', rebind }),
          makeToolSet(),
        ),
        { message: /rebind must be a short list of binding names/ },
      );
    }
    t.deepEqual(names(), []);
    // A well-formed list reaches the provisioner as given.
    await E(factory).create(
      harden({ sessionId: 'session-a', rebind: ['image'] }),
      makeToolSet(),
    );
    t.deepEqual(names(), ['provision']);
  });

  test(`${label} a refused plan propagates without any factory-side cleanup call`, async t => {
    const { factory, names, failProvision } = makeHarness();
    failProvision(true);
    await t.throwsAsync(
      E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
      { message: /owner refused the plan/ },
    );
    t.deepEqual(names(), ['provision']);
    failProvision(false);
    await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
    t.deepEqual(names(), ['provision', 'provision']);
  });
};
