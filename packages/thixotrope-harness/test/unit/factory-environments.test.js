// @ts-check
// The factory's environment wiring (designs/m6-interfaces.md 3.9, 4.1,
// 4.6): preset availability by the `environments` setting, `provide` on
// creation, the binder after `make`, the releaser on a rolled-back
// creation, and the delete hook (after the subagents' own). The real
// factory program (guest/factory/main.js) in Node; the EnvironmentsAdmin
// fake is built from the resource's own guard.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import {
  environmentInterfaces,
  environmentObjectKinds,
  environmentTexts,
} from '../../guest/lib/guards/environments.js';
import { environmentKinds } from '../../guest/lib/environment-prompt.js';
import { stagingSources } from '../../guest/factory/factory.js';
import { make } from '../../guest/factory/main.js';
import { makeDeletions } from '../../guest/factory/delete.js';
import {
  environmentProviders,
  environmentServices,
  releaseEnvironment,
} from '../../guest/factory/environments.js';
import { makeHarnessSettings } from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { makeStartCount } from '../../guest/factory/starts.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const settle = async () => {
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * An EnvironmentsAdmin over the real guard that records every call in
 * `log` (shared with the fake sessions, so order is visible).
 * @param {string[]} log
 */
const makeEnvironmentsAdmin = log => {
  /** @type {Map<any, string>} */
  const keys = new Map();
  let next = 0;
  /** @type {any[]} */
  const requests = [];
  const failures = { releaseSession: 0 };
  const admin = makeExo(
    'EnvironmentsAdmin',
    environmentInterfaces.EnvironmentsAdmin,
    {
      getSettings: () => undefined,
      makeWorkspaceSeed: () => {
        throw Error('not used');
      },
      configure: async () => {
        throw Error('not used');
      },
      status: async () => {
        throw Error('not used');
      },
      /** @param {any} request `{ workspace, shell }` */
      provide: request => {
        requests.push(request);
        const { workspace, shell } = request;
        next += 1;
        const key = `e${next}`;
        log.push(`provide ${key} ${workspace} ${shell}`);
        const control = makeExo(
          'EnvironmentControl',
          environmentInterfaces.EnvironmentControl,
          {
            useWorkspaceSeed: () => {
              throw Error('not used');
            },
            describe: () =>
              harden({ workspace, shell, stopped: false, released: false }),
            port: async () => Far('ShellPort', {}),
            stop: async () => undefined,
            emergencyStop: async () => undefined,
            resume: () => undefined,
          },
        );
        keys.set(control, key);
        /** @type {Record<string, any>} */
        const kit = { control };
        if (workspace) kit.workspace = Far('Git', {});
        if (shell) kit.shell = Far('Shell', {});
        return harden(kit);
      },
      /**
       * @param {any} control
       * @param {any} session
       */
      bindSession: (control, session) => {
        keys.set(session, /** @type {string} */ (keys.get(control)));
        log.push(`bindSession ${keys.get(control)}`);
      },
      /** @param {any} control */
      release: control => {
        log.push(`release ${keys.get(control)}`);
      },
      /** @param {any} session */
      releaseSession: session => {
        log.push(`releaseSession ${keys.get(session) ?? 'none'}`);
        if (failures.releaseSession > 0) {
          failures.releaseSession -= 1;
          throw Error('manager failed');
        }
      },
    },
  );
  return { admin, failures, requests };
};

const SOURCE = `/* session */ ${'s'.repeat(100)}`;

/** The factory program over fakes; `failMake` fails the next `make`s. */
const makeWorld = () => {
  /** @type {string[]} */
  const log = [];
  const state = { failMake: 0 };
  /** @type {any[]} */
  const made = [];
  const vats = Far('ThixotropeWorkerController', {
    createWorker: async () =>
      Far('ThixotropeWorkerFacade', {
        /** @param {string} source */
        evaluate: async source =>
          source === stagingSources.evaluate
            ? Far('SpareMaker', {
                /** @param {any} args */
                make: async args => {
                  log.push(`make ${args.config.key}`);
                  if (state.failMake > 0) {
                    state.failMake -= 1;
                    throw Error('make failed');
                  }
                  made.push(args);
                  return harden({
                    session: Far('Session', {}),
                    internal: Far('SessionInternal', {
                      deleteSelf: () => {
                        log.push('deleteSelf');
                      },
                      blobPage: async () => harden({ blobs: [] }),
                    }),
                  });
                },
              })
            : true,
        retire: async () => undefined,
      }),
  });
  const host = Far('AgentHostAdmin', {
    forSession: () => Far('SessionHostFacet', {}),
    bindSession: () => undefined,
    onStart: () => Far('Registration', { cancel: () => undefined }),
    listPublisher: () => Far('ListPublisher', { publish: () => undefined }),
    releaseBlobs: () => undefined,
    releaseArchive: () => undefined,
  });
  const root = make({ host, vats });
  const digest = createHash('sha256').update(SOURCE).digest('hex');
  root.loadSessionProgram(harden({ digest, index: 0, count: 1, text: SOURCE }));
  root.configure(harden({ spareSessions: 0, spareExec: 0 }));
  const factory = root.getOperator().getFactory();
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'Fake' }),
  });
  /** @param {string} label */
  const preset = label =>
    factory
      .listPresets()
      .find((/** @type {any} */ p) => p.describe().label === label);
  /** @param {string} label */
  const create = label =>
    factory.createSession(harden({ preset: preset(label), backend, at: 1 }));
  const environments = makeEnvironmentsAdmin(log);
  const attach = () =>
    root.configure(harden({ environments: environments.admin }));
  return {
    log,
    state,
    made,
    factory,
    preset,
    create,
    attach,
    environments,
    catalog: root.getOperator().getPresets(),
  };
};

test('the provider kinds are the resource kinds', t => {
  t.deepEqual(Object.values(environmentKinds), [...environmentObjectKinds]);
  t.deepEqual(
    environmentProviders.map(p => p.kind),
    [...environmentObjectKinds],
  );
  t.is(texts.runnerRequired, environmentTexts.runnerRequired);
});

test('without the setting, presets with a workspace or shell are unavailable with runnerRequired; with it, available', async t => {
  const world = makeWorld();
  const availability = () =>
    world.factory
      .listPresets()
      .map((/** @type {any} */ p) => p.describe())
      .map((/** @type {any} */ v) => [
        v.label,
        v.available,
        v.unavailableReason,
      ]);
  t.deepEqual(availability(), [
    ['chat-only', true, undefined],
    ['development', false, texts.runnerRequired],
    ['general', true, undefined],
    ['new-project', false, texts.runnerRequired],
    ['voice', false, texts.runnerRequired],
  ]);
  await t.throwsAsync(() => world.create('development'), {
    message: texts.runnerRequired,
  });
  t.deepEqual(world.log, [], 'nothing provided, nothing made');
  world.attach();
  t.deepEqual(
    availability().map(([label, available]) => [label, available]),
    [
      ['chat-only', true],
      ['development', true],
      ['general', true],
      ['new-project', true],
      ['voice', true],
    ],
  );
});

test('only project development sessions request their selected workspace seed', async t => {
  const world = makeWorld();
  world.attach();
  const workspaceSeed = harden({
    project: 'thixotrope',
    commit: 'ab'.repeat(20),
  });
  const base = world.preset('development').describe();
  world.catalog.create(
    harden({
      label: 'Thixotrope development',
      template: 'development',
      objects: base.objects,
      workspaceSeed,
    }),
    0,
  );
  await world.create('Thixotrope development');
  await world.create('development');
  t.deepEqual(world.environments.requests, [
    { workspace: true, shell: true, workspaceSeed },
    { workspace: true, shell: true },
  ]);
});

test('creation provides what the preset selects, binds after make, and chat-only gets nothing', async t => {
  const world = makeWorld();
  world.attach();
  await world.create('development');
  await settle();
  t.deepEqual(world.log, ['provide e1 true true', 'make s1', 'bindSession e1']);
  const { services } = world.made[0];
  t.truthy(services.workspace);
  t.truthy(services.shell);
  t.truthy(services.environment);
  t.deepEqual(services.environment.describe(), {
    workspace: true,
    shell: true,
    stopped: false,
    released: false,
  });

  world.log.length = 0;
  await world.create('new-project');
  await settle();
  t.deepEqual(world.log, [
    'provide e2 true false',
    'make s2',
    'bindSession e2',
  ]);
  t.truthy(world.made[1].services.workspace);
  t.is(world.made[1].services.shell, undefined);

  world.log.length = 0;
  await world.create('chat-only');
  await settle();
  t.deepEqual(world.log, ['make s3']);
  const chat = world.made[2].services;
  t.is(chat.environment, undefined);
  t.is(chat.workspace, undefined);
  t.is(chat.shell, undefined);
});

test('a creation that fails after provide releases its environment and binds nothing', async t => {
  const world = makeWorld();
  world.attach();
  world.state.failMake = 1;
  await t.throwsAsync(() => world.create('development'), {
    message: 'make failed',
  });
  await settle();
  t.deepEqual(world.log, ['provide e1 true true', 'make s1', 'release e1']);
  t.is(world.factory.listSessions().rows.length, 0);
});

test('delete releases the environment by session before the fence; a failed release leaves the delete to resume', async t => {
  const world = makeWorld();
  world.attach();
  const session = await world.create('development');
  await settle();
  world.log.length = 0;
  world.environments.failures.releaseSession = 1;
  await t.throwsAsync(() => world.factory.deleteSession(session), {
    message: 'manager failed',
  });
  t.deepEqual(world.log, ['releaseSession e1'], 'not fenced yet');
  await world.factory.deleteSession(session);
  t.deepEqual(world.log, [
    'releaseSession e1',
    'releaseSession e1',
    'deleteSelf',
  ]);
});

test('without the setting the delete hook does nothing', async t => {
  const world = makeWorld();
  const session = await world.create('chat-only');
  world.log.length = 0;
  await world.factory.deleteSession(session);
  t.deepEqual(world.log, ['deleteSelf']);
  await releaseEnvironment({ session, settings: undefined });
});

test('handed to makeDeletions after the subagents hook, the release runs after the children are deleted', async t => {
  /** @type {string[]} */
  const log = [];
  const environments = makeEnvironmentsAdmin(log);
  const settings = makeHarnessSettings();
  settings.set(harden({ environments: environments.admin }));
  const rows = makeRowTable();
  const row = rows.add({
    title: 't',
    backendTitle: 'b',
    modelId: 'm',
    userInitiated: true,
  });
  const session = Far('Session', {});
  rows.ready(
    row,
    {
      session,
      internal: Far('SessionInternal', {
        deleteSelf: () => {
          log.push('deleteSelf');
        },
        blobPage: async () => harden({ blobs: [] }),
      }),
    },
    { facade: undefined, execVat: undefined },
  );
  const deletions = makeDeletions({
    admin: Far('AgentHostAdmin', {
      releaseBlobs: () => undefined,
      releaseArchive: () => undefined,
    }),
    rows,
    starts: makeStartCount(),
    hooks: harden([
      // A stand-in for the subagents' deleteChildren (it stands first).
      async () => {
        await null;
        log.push('deleteChildren');
      },
      (/** @type {{ session: any }} */ { session: s }) =>
        releaseEnvironment({ session: s, settings }),
    ]),
  });
  await deletions.delete(session);
  t.deepEqual(log, ['deleteChildren', 'releaseSession none', 'deleteSelf']);
});

test('the services builder refuses a selected object without an admin and answers nothing without one selected', async t => {
  const settings = makeHarnessSettings();
  const snapshot = harden({
    objects: [{ kind: environmentKinds.workspace, label: 'workspace' }],
  });
  await t.throwsAsync(
    () => environmentServices({ presetSnapshot: snapshot, settings }),
    { message: texts.runnerRequired },
  );
  t.deepEqual(
    await environmentServices({
      presetSnapshot: harden({ objects: [] }),
      settings,
    }),
    {},
  );
  t.deepEqual(await environmentServices({ settings }), {});
});

test('the setting is kept and answered in current()', t => {
  const settings = makeHarnessSettings();
  t.is(settings.environments(), undefined);
  t.false('environments' in settings.current());
  const { admin } = makeEnvironmentsAdmin([]);
  settings.set(harden({ environments: admin }));
  t.is(settings.environments(), admin);
  t.is(settings.current().environments, admin);
  settings.set(harden({ turnDeadlineMs: 5 }));
  t.is(settings.environments(), admin, 'other changes keep it');
});
