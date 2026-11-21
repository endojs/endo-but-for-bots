// @ts-check
// The environments manager and the adapter's binding
// (resources/environments/durable.js, impl/attach.js, impl/ops.js;
// m6-interfaces.md D-M6-2, D-M6-3, D-M6-5, D-M6-9, 3.2-3.7, 3.10, 4.5-4.8,
// 7). The manager runs in Node over a fake manager kit; each incarnation is
// the real binding (real layout over a temporary state directory, the real
// ops facet) over parts that record what they are asked: git answers of the
// real shapes, a runner, ShellPorts made with the real ShellPort guard,
// ImageSources with M8's guard, and the real exec-path record. A hub proxy
// between the manager and the ops facet retires an incarnation as a
// SIGKILL would, optionally after applying the call it breaks.
import '../unit/_m1a-prelude.js';

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentInterfaces as I,
  environmentLimits as L,
  environmentMethodNames,
  environmentTexts as T,
  gitAbsentMethodNames,
} from '../../guest/lib/guards/environments.js';
import {
  lazyTable,
  shapes as baseShapes,
} from '../../guest/lib/guards/base.js';
import {
  imageInterfaceBuilders,
  imageShapeBuilders,
} from '../../guest/lib/interfaces.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import {
  SERVICE_KEY,
  make as makeManagerVat,
  sameSettings,
} from '../../resources/environments/durable.js';
import { makeEnvironmentsBinding } from '../../resources/environments/impl/attach.js';
import { boundCommandRecord } from '../../resources/environments/impl/command-output.js';
import {
  defaultRuntimes,
  makeBindingParts,
} from '../../resources/environments/impl/index.js';
import { loadEnvironments } from '../../resources/environments/ephemeral.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * M8's ImageSource guard, over the base table.
 * @type {any}
 */
const imageTable = lazyTable(
  {
    ...imageShapeBuilders(() => imageTable),
    ...imageInterfaceBuilders(() => imageTable),
  },
  baseShapes,
);

const fakeSettings = harden({
  runtime: 'fake',
  allowedCommands: ['sh', 'git', 'true'],
});
const digest = 'a'.repeat(64);

/** Answers of the real shapes, per git op. */
const gitAnswers = harden({
  status: { branch: 'main', entries: [], truncated: false },
  diff: { text: '', truncated: false },
  log: { commits: [], truncated: false },
  branches: { branches: [], truncated: false },
  currentBranch: 'main',
  trackingStatus: {
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
  },
  stashList: { stashes: [], truncated: false },
  commit: { branch: 'main', head: 'b'.repeat(40) },
  add: { branch: 'main', head: 'b'.repeat(40) },
});

const raw = harden({
  stdout: new TextEncoder().encode('hi\n'),
  stderr: new Uint8Array(0),
  stdoutCut: false,
  stderrCut: false,
  exitCode: 0,
  signal: null,
  timedOut: false,
  ms: 1,
});

/**
 * Parts that record their calls. `fail` names a part call that fails once.
 */
const makeParts = () => {
  /** @type {any[][]} */
  const log = [];
  /** @type {Set<string>} */
  const failOnce = new Set();
  /** @type {any} */
  let gitOverride;
  /** @param {string} name */
  const maybeFail = name => {
    if (failOnce.delete(name)) throw Error(`${name} failed`);
  };
  /** @type {import('../../resources/environments/impl/attach.js').PartsContext[]} */
  const contexts = [];
  /** @param {import('../../resources/environments/impl/attach.js').PartsContext} context */
  const parts = context => {
    contexts.push(context);
    const { layout, settings } = context;
    return {
      git: {
        run: async (
          /** @type {string} */ key,
          /** @type {{ op: string, args: unknown[] }} */ request,
        ) => {
          log.push(['git', key, request.op]);
          if (gitOverride !== undefined) return gitOverride(key, request);
          await layout.ensureWorkspace(key);
          return /** @type {any} */ (gitAnswers)[request.op];
        },
        removeStaleLock: async (/** @type {string} */ key) => {
          log.push(['removeStaleLock', key]);
          return false;
        },
        forget: (/** @type {string} */ key) => {
          log.push(['forget', key]);
        },
      },
      runner: {
        exec: async (
          /** @type {string} */ key,
          /** @type {string[]} */ argv,
        ) => {
          log.push(['exec', key, ...argv]);
          return raw;
        },
        inspect: () =>
          harden({
            allowedCommands: [...settings.allowedCommands],
            timeoutMs: L.defaultCommandTimeoutMs,
            maxOutputBytes: L.streamBytes,
          }),
        stop: async (/** @type {string} */ key) => {
          log.push(['stop', key]);
          maybeFail('stop');
        },
        release: async (/** @type {string} */ key) => {
          log.push(['release', key]);
          maybeFail('release');
        },
        sweep: async () => {
          log.push(['sweep']);
          return harden({ stopped: 0 });
        },
        runningCount: () => 0,
      },
      ports: (
        /** @type {string} */ key,
        /** @type {{ isWithdrawn: (key: string) => boolean }} */ {
          isWithdrawn,
        },
      ) =>
        makeExo('ShellPort', I.ShellPort, {
          runCommand: async () => {
            if (isWithdrawn(key)) throw Error(T.stopped);
            return harden({ status: 'ok', text: '{}' });
          },
          inspect: async () => harden({ status: 'ok', text: '{}' }),
        }),
      images: async (
        /** @type {string} */ key,
        /** @type {string[]} */ _segments,
        /** @type {{ isWithdrawn: (key: string) => boolean }} */ {
          isWithdrawn,
        },
      ) =>
        makeExo('ImageSource', imageTable.ImageSource, {
          size: async () => {
            if (isWithdrawn(key)) throw Error(T.stopped);
            return 3;
          },
          readBase64: async () => {
            if (isWithdrawn(key)) throw Error(T.stopped);
            return harden({ data: 'AAAA', done: true });
          },
        }),
      commandRecord: boundCommandRecord,
    };
  };
  return {
    parts,
    log,
    contexts,
    /** @param {string} name */
    failOnce: name => failOnce.add(name),
    /** @param {any} fn */
    overrideGit: fn => {
      gitOverride = fn;
    },
  };
};

/**
 * A fake manager kit: `register` binds a fresh incarnation (the real
 * binding) when none is live, rebinds on other settings, and does nothing
 * for the same registration; `restart()` retires the live incarnation as a
 * SIGKILL does; `lifecycle.started()` builds the next one.
 * @param {import('ava').ExecutionContext} t
 * @param {{ checkOk?: boolean, real?: boolean }} [options] `real`: the
 *   composition `impl/index.js` makes (real parts, the real fake runtime)
 */
const makeKit = (t, { checkOk = true, real = false } = {}) => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const stateDir = mkdtempSync(join(harnessRoot, 'tmp', 'envm-'));
  t.teardown(() => rmSync(stateDir, { recursive: true, force: true }));
  const fake = makeParts();
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const attaches = [];
  let incarnations = 0;
  let binds = 0;
  let unbinds = 0;
  /** @type {string | undefined} */
  let dieAfter;
  /** @type {any} */
  let options;
  /** @type {any} */
  let desired;
  /** @type {{ retired: boolean, binding: any, spec: any } | undefined} */
  let current;
  const runtimes = harden({
    fake: () => harden({ kind: 'fake', check: async () => ({ ok: true }) }),
    podman: () =>
      harden({
        kind: 'podman',
        check: async () =>
          checkOk
            ? { ok: true }
            : { ok: false, reason: `absent at ${stateDir}` },
      }),
  });

  /**
   * The hub between the manager and one incarnation's ops facet.
   * @param {any} ops
   * @param {{ retired: boolean }} incarnation
   */
  const hubProxy = (ops, incarnation) =>
    Far(
      'EnvironmentsOps',
      Object.fromEntries(
        environmentMethodNames.EnvironmentsOps.map(name => [
          name,
          async (/** @type {any[]} */ ...args) => {
            if (incarnation.retired) throw Error(HUB_RETIRED_MESSAGE);
            calls.push([name, ...args]);
            const answer = /** @type {any} */ (E(ops))[name](...args);
            if (dieAfter === name) {
              dieAfter = undefined;
              await answer.catch(() => {});
              incarnation.retired = true;
              throw Error(HUB_RETIRED_MESSAGE);
            }
            return answer;
          },
        ]),
      ),
    );

  const bindDesired = async () => {
    const incarnation = /** @type {NonNullable<typeof current>} */ (current);
    const { sink, settings } = desired;
    const proxied = harden({
      settings,
      sink: Far('EnvironmentsSink', {
        attach: async (/** @type {any} */ ops, /** @type {string} */ name) => {
          const work = await E(sink).attach(hubProxy(ops, incarnation), name);
          attaches.push(work);
          return work;
        },
        stopped: (/** @type {string[]} */ keys) => E(sink).stopped(keys),
        released: (/** @type {string[]} */ keys) => E(sink).released(keys),
      }),
    });
    binds += 1;
    await incarnation.binding.bind(SERVICE_KEY, proxied);
    incarnation.spec = desired;
  };
  const freshIncarnation = () => {
    incarnations += 1;
    current = {
      retired: false,
      spec: undefined,
      binding: makeEnvironmentsBinding({
        incarnation: `i${incarnations}`,
        parts: real ? makeBindingParts : fake.parts,
        runtimes: real ? defaultRuntimes : runtimes,
        stateDir,
      }),
    };
  };
  /** @param {string} key */
  const bound = key => harden({ handle: {}, status: { key, status: 'bound' } });

  const makeManager = (/** @type {any} */ given) => {
    options = given;
    return harden({
      register: async (/** @type {string} */ key, /** @type {any} */ spec) => {
        try {
          if (current !== undefined && !current.retired && current.spec) {
            if (options.same(current.spec, spec)) return bound(key);
            t.true(options.replaces(current.spec, spec));
            await current.binding.unbind({ key }, key);
            unbinds += 1;
            desired = spec;
            await bindDesired();
            return bound(key);
          }
          desired = spec;
          freshIncarnation();
          await bindDesired();
          return bound(key);
        } catch (error) {
          return harden({
            handle: {},
            status: { key, status: 'inactive', error: `${error}` },
          });
        }
      },
      keys: () => harden(desired === undefined ? [] : [SERVICE_KEY]),
      lifecycle: Far('ManagerLifecycle', {
        started: async () => {
          if (desired === undefined) return;
          freshIncarnation();
          await bindDesired();
        },
        exited: async () => {},
      }),
    });
  };
  const { facet: admin, lifecycle } = makeManagerVat({ makeManager });
  return {
    admin,
    lifecycle,
    stateDir,
    calls,
    attaches,
    ...fake,
    binds: () => binds,
    unbinds: () => unbinds,
    incarnations: () => incarnations,
    /** A SIGKILL of the adapter: its ops facet is a tombstone. */
    kill: () => {
      if (current !== undefined) current.retired = true;
    },
    /** A daemon restart: the adapter killed, the next one restored. */
    restart: async () => {
      if (current !== undefined) current.retired = true;
      await lifecycle.started();
    },
    /** @param {string} name the ops method that applies, then breaks */
    dieAfter: name => {
      dieAfter = name;
    },
  };
};

/**
 * The manager's status once `done` holds: the adapter reports stops and
 * releases sendOnly, so a test waits for the observable acknowledgement.
 * @param {any} admin
 * @param {(status: { environments: number, pendingStops: number, pendingReleases: number }) => boolean} done
 */
const statusWhen = async (admin, done) => {
  let status = await E(admin).status();
  const deadline = Date.now() + 10_000;
  while (!done(status)) {
    if (Date.now() >= deadline)
      throw Error(`Manager status did not settle: ${JSON.stringify(status)}`);
    // eslint-disable-next-line no-await-in-loop -- polling, in order
    await new Promise(r => setTimeout(r, 10));
    // eslint-disable-next-line no-await-in-loop -- polling, in order
    status = await E(admin).status();
  }
  return status;
};

/** @param {any} kit */
const configured = async kit => {
  await E(kit.admin).configure(fakeSettings);
  return kit;
};

test('settings are equal field by field, lists element by element', t => {
  t.true(sameSettings(fakeSettings, { ...fakeSettings }));
  t.true(
    sameSettings(fakeSettings, {
      runtime: 'fake',
      allowedCommands: ['sh', 'git', 'true'],
    }),
  );
  t.false(
    sameSettings(fakeSettings, { ...fakeSettings, allowedCommands: ['sh'] }),
  );
  t.false(sameSettings(fakeSettings, { ...fakeSettings, idleStopMs: 5 }));
  t.false(sameSettings(fakeSettings, undefined));
});

test('unconfigured: no registration, status says so, provide refuses', async t => {
  const kit = makeKit(t);
  t.deepEqual(await E(kit.admin).status(), {
    state: 'unconfigured',
    environments: 0,
    pendingStops: 0,
    pendingReleases: 0,
  });
  t.throws(() => kit.admin.provide({ workspace: true, shell: true }), {
    message: T.notConfigured,
  });
  t.is(kit.binds(), 0);
});

test('configure refuses a pin that is not a digest; binds the adapter once; equal settings only reattach', async t => {
  const kit = makeKit(t);
  await t.throwsAsync(
    E(kit.admin).configure(
      harden({ runtime: 'podman', allowedCommands: ['sh'], image: 'node:22' }),
    ),
    { message: T.imageRefused },
  );
  await t.throwsAsync(
    E(kit.admin).configure(
      harden({ runtime: 'docker', allowedCommands: ['sh'] }),
    ),
    { message: T.imageRefused },
  );
  t.is(kit.binds(), 0);
  const status = await E(kit.admin).configure(fakeSettings);
  t.deepEqual(status, {
    state: 'ready',
    environments: 0,
    pendingStops: 0,
    pendingReleases: 0,
    runtime: 'fake',
    running: 0,
  });
  t.is(kit.binds(), 1);
  // The incarnation's first bind swept what this state owns, made nothing.
  t.deepEqual(kit.log, [['sweep']]);
  t.true(existsSync(join(kit.stateDir, 'environments', 'tag')));
  await E(kit.admin).configure(harden({ ...fakeSettings }));
  t.is(kit.binds(), 1, 'equal settings: no rebind');
  // Other settings replace the binding: the old runner is swept.
  await E(kit.admin).configure(
    harden({ ...fakeSettings, allowedCommands: ['sh'] }),
  );
  t.is(kit.binds(), 2);
  t.is(kit.unbinds(), 1);
  t.is(kit.incarnations(), 1);
  t.is(kit.contexts.at(-1)?.settings.allowedCommands.length, 1);
  t.deepEqual(kit.log, [['sweep'], ['sweep']]);
});

test('an absent image: status refused, commands fail with imageRefused, git still works', async t => {
  const kit = makeKit(t, { checkOk: false });
  const status = await E(kit.admin).configure(
    harden({
      runtime: 'podman',
      allowedCommands: ['sh'],
      image: `registry.test/dev@sha256:${digest}`,
    }),
  );
  t.is(status.state, 'refused');
  t.is(status.error, T.imageRefused);
  const kitOf = kit.admin.provide({ workspace: true, shell: true });
  await t.throwsAsync(E(kitOf.shell).runCommand('sh', ['-c', 'true']), {
    message: T.imageRefused,
  });
  t.deepEqual(await E(kitOf.workspace).currentBranch(), 'main');
});

test('provide mints identities and touches no adapter; a shell comes with its workspace', async t => {
  const kit = await configured(makeKit(t));
  const before = kit.calls.length;
  const full = kit.admin.provide({ workspace: true, shell: true });
  const gitOnly = kit.admin.provide({ workspace: true, shell: false });
  const shellOnly = kit.admin.provide({ workspace: false, shell: true });
  t.is(kit.calls.length, before, 'no adapter call');
  t.deepEqual(Object.keys(full).sort(), ['control', 'shell', 'workspace']);
  t.deepEqual(Object.keys(gitOnly).sort(), ['control', 'workspace']);
  t.deepEqual(Object.keys(shellOnly).sort(), ['control', 'shell', 'workspace']);
  t.deepEqual(full.control.describe(), {
    workspace: true,
    shell: true,
    stopped: false,
    released: false,
  });
  t.deepEqual(gitOnly.control.describe(), {
    workspace: true,
    shell: false,
    stopped: false,
    released: false,
  });
  t.false(existsSync(join(kit.stateDir, 'environments', 'sessions')));
  const status = await E(kit.admin).status();
  t.is(status.environments, 3);
});

test('the Git facets: reads and writes forward with the key; the reader has no write; no facet has a rewrite or remote method', async t => {
  const kit = await configured(makeKit(t));
  const { workspace, control } = kit.admin.provide({
    workspace: true,
    shell: false,
  });
  t.deepEqual(await E(workspace).status(), gitAnswers.status);
  t.deepEqual(await E(workspace).commit('a change'), gitAnswers.commit);
  const gitCalls = kit.calls.filter(call => call[0] === 'git');
  t.deepEqual(
    gitCalls.map(([, key, request]) => [key, request.op, request.args]),
    [
      ['e1', 'status', []],
      ['e1', 'commit', ['a change']],
    ],
  );
  const reader = workspace.readOnly();
  t.is(workspace.readOnly(), reader, 'one reader per environment');
  t.deepEqual(await E(reader).log(harden({ limit: 5 })), gitAnswers.log);
  await t.throwsAsync(E(reader).commit('no'));
  for (const name of gitAbsentMethodNames) {
    t.false(name in workspace, name);
    t.false(name in reader, name);
  }
  t.regex(workspace.help(), /^Git: status, diff/);
  t.regex(workspace.help('commit'), /^Git\.commit\(message\)/);
  t.regex(reader.help(), /^GitReader: /);
  // The control is no Git facet: the factory cannot pass it as one.
  t.throws(() => kit.admin.bindSession(workspace, Far('Session', {})), {
    message: 'Not an environment of this manager',
  });
  t.is(control.describe().released, false);
});

test('an answer out of its shape never leaves the manager', async t => {
  const kit = await configured(makeKit(t));
  const { workspace } = kit.admin.provide({ workspace: true, shell: false });
  kit.overrideGit(async () =>
    harden({ branch: 'main', entries: [], truncated: false, extra: 1 }),
  );
  await t.throwsAsync(E(workspace).status());
});

test('no host path in a failure: the workspace is /workspace, the state <state>', async t => {
  const kit = await configured(makeKit(t));
  const { workspace } = kit.admin.provide({ workspace: true, shell: false });
  const dir = join(kit.stateDir, 'environments', 'sessions', 'e1', 'workspace');
  kit.overrideGit(async () => {
    throw Error(`fatal: cannot lock ref in ${dir}/.git and ${kit.stateDir}/x`);
  });
  const error = await t.throwsAsync(E(workspace).status());
  t.is(
    error?.message,
    'fatal: cannot lock ref in /workspace/.git and <state>/x',
  );
});

test('legacy seed markers are manager-owned, immutable and accepted only before workspace use', async t => {
  const kit = makeKit(t);
  t.is(kit.admin.getSettings(), undefined);
  await configured(kit);
  t.deepEqual(kit.admin.getSettings(), fakeSettings);
  const workspaceSeed = harden({
    project: 'thixotrope',
    commit: 'ab'.repeat(20),
  });
  const marker = kit.admin.makeWorkspaceSeed(workspaceSeed);
  t.deepEqual(marker.describe(), workspaceSeed);
  const { control } = kit.admin.provide({ workspace: true, shell: true });
  t.throws(
    () =>
      control.useWorkspaceSeed(
        Far('WorkspaceSeedMarker', { describe: () => workspaceSeed }),
      ),
    { message: 'Unknown workspace seed marker' },
  );
  control.useWorkspaceSeed(marker);
  await E(control).port();
  control.useWorkspaceSeed(marker);
  const replacement = kit.admin.makeWorkspaceSeed(
    harden({ ...workspaceSeed, commit: 'f'.repeat(40) }),
  );
  t.throws(() => control.useWorkspaceSeed(replacement), {
    message: 'Workspace seed changed',
  });
  const fresh = kit.admin.provide({ workspace: true, shell: true });
  await E(fresh.control).port();
  t.throws(() => fresh.control.useWorkspaceSeed(marker), {
    message: 'Workspace is already in use',
  });
  t.deepEqual(
    kit.calls.filter(call => call[0] === 'port'),
    [
      ['port', 'e1', workspaceSeed],
      ['port', 'e2'],
    ],
  );
});

test('a seeded environment sends its immutable selection on first use and after native restart', async t => {
  const kit = await configured(makeKit(t));
  const workspaceSeed = harden({
    project: 'thixotrope',
    commit: 'a1'.repeat(20),
  });
  const { workspace, shell, control } = kit.admin.provide({
    workspace: true,
    shell: true,
    workspaceSeed,
  });
  const ordinary = kit.admin.provide({ workspace: true, shell: true });
  await E(control).port();
  await E(shell).runCommand('true', []);
  kit.overrideGit(() => gitAnswers.status);
  await E(workspace).status();
  kit.kill();
  await E(workspace.readOnly()).status();
  await t.throwsAsync(E(workspace).openImage(['photo.png']), {
    message: 'Workspace seed bundle is missing',
  });
  const seededCalls = kit.calls.filter(call => call[1] === 'e1');
  t.deepEqual(
    seededCalls.map(call => call[0]),
    ['port', 'runCommand', 'git', 'git', 'openImage'],
  );
  for (const call of seededCalls) t.deepEqual(call.at(-1), workspaceSeed);
  await E(ordinary.workspace).status();
  const unseeded = kit.calls.find(
    call => call[0] === 'git' && call[1] === 'e2',
  );
  t.is(unseeded.length, 3);
});

test('a read whose adapter call breaks reattaches and is sent once more', async t => {
  const kit = await configured(makeKit(t));
  const { workspace, shell } = kit.admin.provide({
    workspace: true,
    shell: true,
  });
  await E(workspace).status();
  // The adapter alone exits: the manager's next call finds it retired.
  kit.kill();
  t.deepEqual(await E(workspace).status(), gitAnswers.status);
  t.is(kit.incarnations(), 2);
  // The new incarnation's first bind swept the old one's leftovers and
  // the stale git locks of every workspace on disk.
  t.is(kit.log.filter(entry => entry[0] === 'sweep').length, 2);
  t.deepEqual(
    kit.log.filter(entry => entry[0] === 'removeStaleLock'),
    [['removeStaleLock', 'e1']],
  );
  // Applied, then broken: a read is sent again.
  kit.dieAfter('inspect');
  const info = await E(shell).inspect();
  t.deepEqual(info.allowedCommands, ['sh', 'git', 'true']);
  t.is(kit.calls.filter(call => call[0] === 'inspect').length, 2);
});

test('a write whose adapter call breaks is not sent again: outcomeUnknown', async t => {
  const kit = await configured(makeKit(t));
  const { workspace, shell } = kit.admin.provide({
    workspace: true,
    shell: true,
  });
  await E(workspace).status();
  kit.dieAfter('git');
  await t.throwsAsync(E(workspace).commit('once'), {
    message: T.outcomeUnknown,
  });
  t.is(kit.log.filter(entry => entry[2] === 'commit').length, 1);
  kit.dieAfter('runCommand');
  await t.throwsAsync(E(shell).runCommand('sh', ['-c', 'date']), {
    message: T.outcomeUnknown,
  });
  t.is(kit.log.filter(entry => entry[0] === 'exec').length, 1);
  // The next write goes to a fresh incarnation and is answered.
  t.deepEqual(await E(shell).runCommand('true', []), {
    stdout: 'hi\n',
    stderr: '',
    exitCode: 0,
    signal: null,
    truncated: false,
  });
});

test('release by control (rollback) and by session (delete): refused at once, records dropped when the adapter answers', async t => {
  const kit = await configured(makeKit(t));
  const first = kit.admin.provide({ workspace: true, shell: true });
  const second = kit.admin.provide({ workspace: true, shell: true });
  await E(first.workspace).status();
  await E(second.workspace).status();
  const sessions = join(kit.stateDir, 'environments', 'sessions');
  t.true(existsSync(join(sessions, 'e1')));

  kit.admin.release(first.control);
  await t.throwsAsync(E(first.workspace).status(), { message: T.released });
  await t.throwsAsync(E(first.shell).runCommand('true', []), {
    message: T.released,
  });
  await t.throwsAsync(E(first.control).port(), { message: T.released });
  await t.throwsAsync(E(first.control).emergencyStop(), {
    message: T.released,
  });
  t.deepEqual(first.control.describe(), {
    workspace: true,
    shell: true,
    stopped: false,
    released: true,
  });
  kit.admin.release(first.control);

  const session = Far('Session', {});
  kit.admin.bindSession(second.control, session);
  kit.admin.releaseSession(session);
  kit.admin.releaseSession(session);
  kit.admin.releaseSession(Far('Session', {}));
  await t.throwsAsync(E(second.workspace).status(), { message: T.released });

  // Wait for the adapter's answers.
  await statusWhen(kit.admin, status => status.environments <= 0);
  const status = await E(kit.admin).status();
  t.is(status.environments, 0);
  t.is(status.pendingReleases, 0);
  t.false(existsSync(join(sessions, 'e1')));
  t.false(existsSync(join(sessions, 'e2')));
  t.deepEqual(
    kit.log.filter(entry => entry[0] === 'release').map(entry => entry[1]),
    ['e1', 'e2'],
  );
});

test('a release the adapter failed stays pending and is performed after the next attach', async t => {
  const kit = await configured(makeKit(t));
  const { workspace, control } = kit.admin.provide({
    workspace: true,
    shell: false,
  });
  await E(workspace).status();
  kit.failOnce('release');
  kit.admin.release(control);
  await new Promise(r => setTimeout(r, 20));
  t.like(await E(kit.admin).status(), { environments: 1, pendingReleases: 1 });

  await kit.restart();
  t.deepEqual(kit.attaches.at(-1), {
    stops: [],
    releases: ['e1'],
    withdrawn: [],
  });
  await statusWhen(kit.admin, status => status.environments <= 0);
  t.like(await E(kit.admin).status(), { environments: 0, pendingReleases: 0 });
  t.false(existsSync(join(kit.stateDir, 'environments', 'sessions', 'e1')));
});

test('emergency stop withdraws in the manager and the adapter; a new incarnation refuses from its first call; resume restores', async t => {
  const kit = await configured(makeKit(t));
  const { workspace, shell, control } = kit.admin.provide({
    workspace: true,
    shell: true,
  });
  const other = kit.admin.provide({ workspace: true, shell: true });
  const port = await E(control).port();
  const image = await E(workspace).openImage(harden(['img', 'a.png']));
  t.is(await E(image).size(), 3);
  t.is(
    await E(port)
      .runCommand(harden({}))
      .catch(() => 'guard'),
    'guard',
  );

  await E(control).emergencyStop();
  await E(control).emergencyStop();
  t.true(control.describe().stopped);
  t.deepEqual(
    kit.calls
      .filter(call => call[0] === 'stop')
      .map(([, key, options]) => [key, options]),
    [
      ['e1', { withdraw: true }],
      ['e1', { withdraw: true }],
    ],
  );
  for (const call of [
    () => E(workspace).status(),
    () => E(workspace).commit('no'),
    () => E(workspace).openImage(harden(['a.png'])),
    () => E(workspace.readOnly()).diff(),
    () => E(shell).runCommand('true', []),
    () => E(shell).inspect(),
    () => E(control).port(),
  ])
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(call(), { message: T.stopped });
  // Objects of the adapter held from before are refused there.
  await t.throwsAsync(E(image).size(), { message: T.stopped });
  // Another environment is untouched.
  t.deepEqual(await E(other.workspace).status(), gitAnswers.status);
  t.like(await E(kit.admin).status(), { pendingStops: 0 });

  // A restart: the next incarnation learns the withdrawn key from attach.
  await kit.restart();
  t.deepEqual(kit.attaches.at(-1), {
    stops: [],
    releases: [],
    withdrawn: ['e1'],
  });
  await t.throwsAsync(E(control).port(), { message: T.stopped });

  control.resume();
  t.false(control.describe().stopped);
  const fresh = await E(control).port();
  t.not(fresh, port);
  t.deepEqual(
    await E(fresh)
      .inspect(harden({}))
      .catch(() => 'guard'),
    'guard',
  );
  t.deepEqual(await E(workspace).status(), gitAnswers.status);
  t.true(kit.calls.some(call => call[0] === 'resume' && call[1] === 'e1'));
});

test('a failed stop stays pending: emergency stop is incomplete, and the stop is sent again before the next command', async t => {
  const kit = await configured(makeKit(t));
  const { shell, control } = kit.admin.provide({
    workspace: true,
    shell: true,
  });
  kit.failOnce('stop');
  await t.throwsAsync(E(control).emergencyStop(), {
    message: T.stopIncomplete,
  });
  t.like(await E(kit.admin).status(), { pendingStops: 1 });
  t.true(control.describe().stopped, 'withdrawn in the manager anyway');
  // The user's retry is idempotent and completes.
  await E(control).emergencyStop();
  t.like(await E(kit.admin).status(), { pendingStops: 0 });
  control.resume();

  // A cancel's stop that failed is sent again before the next command.
  kit.failOnce('stop');
  await E(control).stop();
  t.like(await E(kit.admin).status(), { pendingStops: 1 });
  kit.log.length = 0;
  await E(shell).runCommand('true', []);
  t.deepEqual(
    kit.log.map(entry => entry[0]),
    ['stop', 'exec'],
  );
  t.like(await E(kit.admin).status(), { pendingStops: 0 });
});

test('a pending stop is performed by the next incarnation and reported', async t => {
  const kit = await configured(makeKit(t));
  const { control } = kit.admin.provide({ workspace: true, shell: true });
  kit.failOnce('stop');
  await E(control).stop();
  t.like(await E(kit.admin).status(), { pendingStops: 1 });
  await kit.restart();
  t.deepEqual(kit.attaches.at(-1), {
    stops: ['e1'],
    releases: [],
    withdrawn: [],
  });
  await statusWhen(kit.admin, status => status.pendingStops <= 0);
  t.like(await E(kit.admin).status(), { pendingStops: 0 });
});

test('records are bounded by maxEnvironments; a release makes room once answered', async t => {
  const kit = await configured(makeKit(t));
  /** @type {any[]} */
  const kits = [];
  for (let i = 0; i < L.maxEnvironments; i += 1)
    kits.push(kit.admin.provide({ workspace: true, shell: false }));
  t.throws(() => kit.admin.provide({ workspace: true, shell: false }), {
    message: T.tooManyEnvironments,
  });
  kit.admin.release(kits[0].control);
  await statusWhen(
    kit.admin,
    status => status.environments < L.maxEnvironments,
  );
  t.truthy(kit.admin.provide({ workspace: true, shell: false }).control);
});

test('the composition: real git, the fake runtime, a real ShellPort; emergency stop refuses the port the session holds', async t => {
  const kit = makeKit(t, { real: true });
  const status = await E(kit.admin).configure(
    harden({ runtime: 'fake', allowedCommands: ['sh', 'git'] }),
  );
  t.like(status, { state: 'ready', runtime: 'fake', running: 0 }, status.error);
  const { workspace, shell, control } = kit.admin.provide({
    workspace: true,
    shell: true,
  });
  t.is(await E(workspace).currentBranch(), 'main');
  const result = await E(shell).runCommand('sh', [
    '-c',
    'printf hi > a.txt && git add a.txt && printf done',
  ]);
  t.like(result, { stdout: 'done', exitCode: 0, truncated: false });
  const after = await E(workspace).status();
  t.deepEqual(
    after.entries.map((/** @type {any} */ entry) => [entry.path, entry.index]),
    [['a.txt', 'A']],
  );
  await t.throwsAsync(E(shell).runCommand('python3', []), {
    message: /is not in the allowlist/,
  });
  const info = await E(shell).inspect();
  t.deepEqual(info.allowedCommands, ['sh', 'git']);
  t.false(JSON.stringify(info).includes(kit.stateDir), 'no host path');

  const port = await E(control).port();
  t.is(await E(control).port(), port, 'one port per key per incarnation');
  await E(control).emergencyStop();
  t.deepEqual(
    await E(port).runCommand(
      harden({
        opId: 'op1',
        args: JSON.stringify({ command: 'sh', args: ['-c', 'true'] }),
        writers: Far('BlobWriters', {}),
      }),
    ),
    { status: 'failed', text: T.stopped },
  );
  await E(control).stop();
  t.like(await E(kit.admin).status(), { running: 0 });
});

test('the loader builds the adapter root from impl/index.js', t => {
  const adapter = loadEnvironments({
    harnessRoot,
    implOptions: { stateDir: harnessRoot },
  });
  t.is(typeof adapter.bind, 'function');
  t.is(typeof adapter.restore, 'function');
});
