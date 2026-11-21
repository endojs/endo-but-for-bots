// @ts-check
/**
 * The environments manager: the durable half of the environments native
 * resource, run in its manager vat (`designs/m6-interfaces.md` D-M6-1,
 * D-M6-2, D-M6-3, D-M6-13 and section 3.10). Thin on purpose: it keeps the
 * identities (one record per environment, keyed by a counter key `e<n>`,
 * and the `Git`, `GitReader`, `Shell` and `EnvironmentControl` exos minted
 * for it), the operator's settings, the work it still owes an adapter (stops
 * and releases) and which environments are emergency-stopped; everything
 * else is the adapter's (`impl/`).
 *
 * Amplification, not ids: every exo finds its record through `recordOf`
 * (a `WeakMap`), a session's record through `bySession` after
 * `bindSession`; the key travels to the adapter only, where it names a
 * directory and a container (F.2 c).
 *
 * Forwarding: through `resources/native-attach.js`. A read whose adapter
 * call breaks (the adapter restarted) reattaches and is sent once more; a
 * write (a git write, a command) is never sent twice and rejects with
 * `environmentTexts.outcomeUnknown` (D-M6-5). Every answer passes the
 * exo's return guard (the op's closed shape) before it leaves this vat.
 *
 * Lazy (D-M6-3): `provide` touches no disk and calls no adapter; the one
 * registration is the service key, whose spec carries the sink and the
 * settings to every adapter incarnation.
 *
 * Runs in a vat: prelude globals only (no clock, timers or randomness),
 * closed records, retained state bounded by `maxEnvironments` (records,
 * the withdrawn keys and the pending work are all subsets of it).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentInterfaces as I,
  environmentLimits as L,
  environmentMethodNames,
  environmentTexts as T,
  environmentTextOf,
  gitOps,
  gitReaderMethodNames,
} from '../../guest/lib/guards/environments.js';
import { guardLimits as limits } from '../../guest/lib/guard-limits.js';
import { assertWorkspaceSeed } from '../../guest/lib/workspace-seed.js';
import { isRetiredBreak } from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import { makeAttachedOps } from '../native-attach.js';

/** @import { WorkspaceSeed } from '../../guest/lib/workspace-seed.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { E, Far } = /** @type {GuestGlobals} */ (globalThis);
// Untyped here: the methods are built from name lists (`gitReads`,
// `gitWrites`), which the typed overload cannot follow; the guards check
// every call.
const { makeExo } = /** @type {any} */ (globalThis);

/** @param {EnvironmentRecord} record */
const seedArgs = record => {
  record.workspaceUsed = true;
  return record.workspaceSeed ? [record.workspaceSeed] : [];
};
harden(seedArgs);

/** The one registration key; the adapter (`impl/index.js`) binds it. */
export const SERVICE_KEY = 'environments';

/**
 * The forwarded git operations the read-only facet has (retried once after
 * a break), and the others, the writes (never sent twice).
 */
const gitReads = harden(gitOps.filter(op => gitReaderMethodNames.includes(op)));
const gitWrites = harden(
  gitOps.filter(op => !gitReaderMethodNames.includes(op)),
);

/**
 * One line per method for `help(method)` (`describeCapability`); the
 * overview lists the facet's methods.
 */
const methodHelp = harden({
  status: 'status({ untracked?, limit?, paths? }): the paths that differ',
  diff: 'diff({ staged?, from?, to?, paths?, stat? }): the diff text',
  log: 'log({ from?, limit?, after?, since?, until? }): commits, newest first',
  branches: 'branches(): local branches and which is current',
  currentBranch: 'currentBranch(): the branch name, or null when detached',
  trackingStatus: 'trackingStatus(): branch and head; never an upstream',
  stashList: 'stashList(): stash entries',
  read: 'read({ items }): lines of worktree files (readSources)',
  openImage: 'openImage(path segments): an ImageSource for a worktree image',
  add: 'add(paths): stage paths',
  restore: 'restore(paths, { staged? }): discard or unstage changes',
  commit: 'commit(message): commit what is staged',
  createBranch:
    'createBranch(name, { startPoint?, switchAfterCreate? }): a new branch',
  switchBranch: 'switchBranch(name): check a branch out',
  renameBranch: 'renameBranch(from, to)',
  deleteBranch: 'deleteBranch(name, { force? })',
  merge: "merge(name, { mode: 'ff-only' | 'merge-commit', message? })",
  stashPush: 'stashPush(message?): stash the changes',
  stashPop: 'stashPop(): apply and drop the newest stash',
  readOnly: 'readOnly(): the read-only facet of this workspace',
  runCommand:
    'runCommand(command, args, { timeoutMs? }): run an allowlisted program in /workspace',
  inspect: 'inspect(): the allowlist, default timeout and output cap',
  help: 'help(method?): this text',
});

/**
 * @param {string} name the interface name
 * @param {readonly string[]} names its methods
 * @param {string | undefined} method
 */
const helpOf = (name, names, method) => {
  if (method !== undefined && names.includes(method))
    return `${name}.${/** @type {Record<string, string>} */ (methodHelp)[method]}`;
  return `${name}: ${names.join(', ')}. Ask help(method) for one of them.`;
};

/**
 * A bounded reason for a status (never more than `reasonUnits`).
 * @param {unknown} error
 */
const reasonOf = error => {
  const message = /** @type {any} */ (error)?.message;
  return (typeof message === 'string' ? message : String(error)).slice(
    0,
    limits.reasonUnits,
  );
};

/**
 * Whether a pin has the digest form `<repository>@sha256:<64 hex>` (R8-41);
 * the adapter checks it again with its presence (`impl/images.js`).
 * @param {unknown} pin
 */
const isDigestPinForm = pin =>
  typeof pin === 'string' && /^[^\s@]+@sha256:[0-9a-f]{64}$/.test(pin);

/**
 * Settings equal field by field (lists element by element): a configure
 * with equal settings only reattaches (D-M6-3, 3.10).
 * @param {Record<string, any> | undefined} a
 * @param {Record<string, any> | undefined} b
 */
export const sameSettings = (a, b) => {
  if (a === undefined || b === undefined) return a === b;
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const x = a[name];
    const y = b[name];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((item, i) => item !== y[i]))
        return false;
    } else if (x !== y) return false;
  }
  return true;
};
harden(sameSettings);

/**
 * @typedef {object} EnvironmentRecord
 * @property {string} key `e<n>`; leaves this vat toward the adapter only
 * @property {boolean} [workspaceUsed]
 * @property {WorkspaceSeed} [workspaceSeed]
 * @property {boolean} stopped emergency-stopped (D-M6-9)
 * @property {boolean} released released with its session or rollback
 * @property {any} control the `EnvironmentControl`
 * @property {any} [git] the writer `Git` (label `workspace`)
 * @property {any} [reader] the `GitReader`, minted on `readOnly()`
 * @property {any} [shellExo] the `Shell` (label `shell`)
 * @property {any} [session] the bound `Session`
 */

/**
 * @param {{ makeManager: (options: any) => any }} powers
 */
export const make = ({ makeManager }) => {
  /** @type {Record<string, any> | undefined} */
  let settings;
  let serial = 0;
  /** @type {Map<string, EnvironmentRecord>} */
  const records = new Map();
  /** @type {WeakMap<object, WorkspaceSeed>} */
  const workspaceSeeds = new WeakMap();
  /** @type {WeakMap<any, EnvironmentRecord>} */
  const recordOf = new WeakMap();
  /** @type {WeakMap<any, EnvironmentRecord>} */
  const bySession = new WeakMap();
  /** Work an adapter owes: keys whose stop or release has not been answered. */
  const pending = { stops: new Set(), releases: new Set() };

  const manager = makeManager({
    label: 'Environments',
    // A configure with equal settings only reattaches; other settings
    // replace the binding and the adapter rebinds with them.
    same: (/** @type {any} */ a, /** @type {any} */ b) =>
      a.sink === b.sink && sameSettings(a.settings, b.settings),
    replaces: () => true,
  });

  const counts = () =>
    harden({
      environments: records.size,
      pendingStops: pending.stops.size,
      pendingReleases: pending.releases.size,
    });

  const spec = () => harden({ sink, settings });

  const attached = makeAttachedOps({
    reconcile: async () => {
      if (settings === undefined) throw Error(T.notConfigured);
      const { status } = await manager.register(SERVICE_KEY, spec());
      if (status.status !== 'bound')
        throw Error(
          environmentTextOf.runtimeFailed(status.error ?? status.status),
        );
    },
    isRetired: isRetiredBreak,
    writeBroken: () => Error(T.outcomeUnknown),
  });

  /**
   * @template T
   * @param {(ops: any) => Promise<T>} fn
   * @param {boolean} [write]
   * @returns {Promise<T>}
   */
  const forward = (fn, write = false) => attached.withOps(fn, { write });

  /**
   * Refuse a call of a released or stopped environment (3.4-3.7).
   * @param {EnvironmentRecord} record
   */
  const assertLive = record => {
    if (record.released) throw Error(T.released);
    if (record.stopped) throw Error(T.stopped);
  };

  /**
   * A stop the adapter has not answered is sent again before the
   * environment runs anything (R4-81 improved, D-16).
   * @param {EnvironmentRecord} record
   */
  const settleStop = async record => {
    if (!pending.stops.has(record.key)) return;
    await forward(ops => E(ops).stop(record.key));
    pending.stops.delete(record.key);
  };

  /**
   * @param {EnvironmentRecord} record
   * @param {string} op
   * @param {unknown[]} args
   * @param {boolean} write
   */
  const forwardGit = async (record, op, args, write) => {
    assertLive(record);
    const seed = seedArgs(record);
    return forward(
      ops =>
        E(ops).git(
          record.key,
          harden({ op, args: harden([...args]) }),
          ...seed,
        ),
      write,
    );
  };

  /**
   * The methods both Git facets have.
   * @param {EnvironmentRecord} record
   * @param {string} name the facet's interface name
   * @param {readonly string[]} names its methods
   */
  const gitReadMethods = (record, name, names) => ({
    ...Object.fromEntries(
      gitReads.map(op => [
        op,
        /** @param {unknown[]} args */
        (...args) => forwardGit(record, op, args, false),
      ]),
    ),
    /** @param {string[]} path */
    openImage: async path => {
      assertLive(record);
      const seed = seedArgs(record);
      return forward(ops => E(ops).openImage(record.key, path, ...seed));
    },
    /** @param {string} [method] */
    help: method => helpOf(name, names, method),
  });

  /** @param {EnvironmentRecord} record */
  const makeReader = record =>
    makeExo(
      'GitReader',
      I.GitReader,
      gitReadMethods(record, 'GitReader', environmentMethodNames.GitReader),
    );

  /** @param {EnvironmentRecord} record */
  const makeGit = record =>
    makeExo('Git', I.Git, {
      ...gitReadMethods(record, 'Git', environmentMethodNames.Git),
      ...Object.fromEntries(
        gitWrites.map(op => [
          op,
          /** @param {unknown[]} args */
          (...args) => forwardGit(record, op, args, true),
        ]),
      ),
      readOnly: () => {
        if (record.reader === undefined) {
          record.reader = makeReader(record);
          recordOf.set(record.reader, record);
        }
        return record.reader;
      },
    });

  /** @param {EnvironmentRecord} record */
  const makeShell = record =>
    makeExo('Shell', I.Shell, {
      /**
       * @param {string} command
       * @param {string[]} args
       * @param {Record<string, number>} [options]
       */
      runCommand: async (command, args, options = {}) => {
        assertLive(record);
        const seed = seedArgs(record);
        await settleStop(record);
        return forward(
          ops =>
            E(ops).runCommand(
              record.key,
              command,
              args,
              harden({ ...options }),
              ...seed,
            ),
          true,
        );
      },
      inspect: async () => {
        assertLive(record);
        return forward(ops => E(ops).inspect(record.key));
      },
      /** @param {string} [method] */
      help: method => helpOf('Shell', environmentMethodNames.Shell, method),
    });

  /**
   * The adapter answered the release of these keys: their records go.
   * @param {readonly string[]} keys
   */
  const dropReleased = keys => {
    for (const key of keys) {
      if (records.get(key)?.released === true) {
        records.delete(key);
        pending.releases.delete(key);
      }
    }
  };

  /**
   * Mark released (every call refused from now) and forward the release;
   * one the adapter did not answer stays pending and is sent again by the
   * next attach. Idempotent.
   * @param {EnvironmentRecord} record
   */
  const releaseRecord = record => {
    if (record.released) return;
    record.released = true;
    pending.stops.delete(record.key);
    pending.releases.add(record.key);
    if (record.session !== undefined) bySession.delete(record.session);
    void forward(ops => E(ops).release(record.key)).then(
      () => dropReleased([record.key]),
      () => {},
    );
  };

  /** @param {EnvironmentRecord} record */
  const makeControl = record =>
    makeExo('EnvironmentControl', I.EnvironmentControl, {
      /** @param {object} marker */
      useWorkspaceSeed: marker => {
        assertLive(record);
        const seed = workspaceSeeds.get(marker);
        if (!seed) throw Error('Unknown workspace seed marker');
        if (record.workspaceSeed !== undefined) {
          if (record.workspaceSeed.commit !== seed.commit)
            throw Error('Workspace seed changed');
          return seed;
        }
        if (record.workspaceUsed) throw Error('Workspace is already in use');
        record.workspaceSeed = seed;
        return seed;
      },
      describe: () =>
        harden({
          workspace: record.git !== undefined,
          shell: record.shellExo !== undefined,
          stopped: record.stopped,
          released: record.released,
        }),
      port: async () => {
        assertLive(record);
        const seed = seedArgs(record);
        await settleStop(record);
        return forward(ops => E(ops).port(record.key, ...seed));
      },
      // Cancel (R4-7): kill the commands and stop the container; workspace
      // and home stay. A failure keeps the stop pending (sent again by the
      // next attach or before the next command).
      stop: async () => {
        if (record.released) return undefined;
        pending.stops.add(record.key);
        await forward(ops => E(ops).stop(record.key)).then(
          () => pending.stops.delete(record.key),
          () => {},
        );
        return undefined;
      },
      // Withdraw here first (every call refused from now), then in the
      // adapter (its ShellPort and ImageSources refused), which also stops.
      emergencyStop: async () => {
        if (record.released) throw Error(T.released);
        record.stopped = true;
        pending.stops.add(record.key);
        try {
          await forward(ops =>
            E(ops).stop(record.key, harden({ withdraw: true })),
          );
        } catch {
          throw Error(T.stopIncomplete);
        }
        pending.stops.delete(record.key);
        return undefined;
      },
      // Starts nothing: the next command starts the environment again.
      resume: () => {
        if (record.released) throw Error(T.released);
        record.stopped = false;
        void forward(ops => E(ops).resume(record.key)).catch(() => {});
        return undefined;
      },
    });

  const sink = makeExo('EnvironmentsSink', I.EnvironmentsSink, {
    /**
     * @param {any} ops this adapter incarnation's ops facet
     * @param {string} _incarnation
     */
    attach: (ops, _incarnation) => {
      attached.attach(ops);
      const withdrawn = [];
      for (const record of records.values())
        if (record.stopped && !record.released) withdrawn.push(record.key);
      return harden({
        stops: [...pending.stops],
        releases: [...pending.releases],
        withdrawn,
      });
    },
    /** @param {string[]} keys */
    stopped: keys => {
      for (const key of keys) pending.stops.delete(key);
    },
    /** @param {string[]} keys */
    released: keys => dropReleased(keys),
  });

  const statusNow = async () => {
    if (settings === undefined)
      return harden({ state: 'unconfigured', ...counts() });
    try {
      const answer = await forward(ops => E(ops).status());
      return harden({ ...answer, ...counts() });
    } catch (error) {
      return harden({
        state: 'refused',
        ...counts(),
        runtime: settings.runtime,
        error: reasonOf(error),
      });
    }
  };

  const admin = makeExo('EnvironmentsAdmin', I.EnvironmentsAdmin, {
    getSettings: () => settings,
    /** @param {WorkspaceSeed} seed */
    makeWorkspaceSeed: seed => {
      assertWorkspaceSeed(seed);
      const marker = makeExo('WorkspaceSeedMarker', I.WorkspaceSeedMarker, {
        describe: () => seed,
      });
      workspaceSeeds.set(marker, seed);
      return marker;
    },
    /** @param {Record<string, any>} wanted `EnvironmentSettings` */
    configure: async wanted => {
      if (wanted.runtime !== 'fake' && !isDigestPinForm(wanted.image))
        throw Error(T.imageRefused);
      settings = harden({ ...wanted });
      await manager.register(SERVICE_KEY, spec());
      return statusNow();
    },
    status: () => statusNow(),
    /** @param {{ workspace: boolean, shell: boolean, workspaceSeed?: WorkspaceSeed }} request */
    provide: ({ workspace, shell, workspaceSeed }) => {
      if (settings === undefined) throw Error(T.notConfigured);
      if (records.size >= L.maxEnvironments) throw Error(T.tooManyEnvironments);
      if (workspaceSeed !== undefined) assertWorkspaceSeed(workspaceSeed);
      serial += 1;
      /** @type {EnvironmentRecord} */
      const record = {
        key: `e${serial}`,
        ...(workspaceSeed === undefined ? {} : { workspaceSeed }),
        stopped: false,
        released: false,
        control: undefined,
      };
      record.control = makeControl(record);
      recordOf.set(record.control, record);
      // A shell always comes with its workspace (`/workspace`).
      if (workspace || shell) {
        record.git = makeGit(record);
        recordOf.set(record.git, record);
      }
      if (shell) {
        record.shellExo = makeShell(record);
        recordOf.set(record.shellExo, record);
      }
      records.set(record.key, record);
      return harden({
        control: record.control,
        ...(record.git === undefined ? {} : { workspace: record.git }),
        ...(record.shellExo === undefined ? {} : { shell: record.shellExo }),
      });
    },
    /**
     * @param {any} control
     * @param {any} session
     */
    bindSession: (control, session) => {
      const record = recordOf.get(control);
      if (record === undefined || record.control !== control)
        throw Error('Not an environment of this manager');
      if (record.released) return;
      record.session = session;
      bySession.set(session, record);
    },
    /** @param {any} control */
    release: control => {
      const record = recordOf.get(control);
      if (record === undefined || record.control !== control)
        throw Error('Not an environment of this manager');
      releaseRecord(record);
    },
    /** @param {any} session */
    releaseSession: session => {
      const record = bySession.get(session);
      if (record !== undefined) releaseRecord(record);
    },
  });

  const lifecycle = Far('EnvironmentsLifecycle', {
    started: () => manager.lifecycle.started(),
    exited: () => manager.lifecycle.exited(),
  });

  return harden({ facet: admin, lifecycle });
};
harden(make);
