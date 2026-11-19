// @ts-check
/**
 * The factory's spare-vat pool and the per-session `ExecHandle` (M1b W1b.5;
 * architecture D-4, section 6; `designs/m1b-interfaces.md` sections 3.4,
 * 3.5, 6.6 and 10.1).
 *
 * The pool keeps up to `spareSessions` (default 2) session vats already
 * loaded with the session program and up to `spareExec` (default 1) exec
 * vats loaded with the exec program, each `{ facade, value, digest }` in
 * the factory heap. A spare is made as spike S6 made it: `E(vats)
 * .createWorker(label)`, the program staged in pieces of at most
 * `programPieceBytes` (one answered `evaluate` each), then one evaluating
 * crank whose value is the program's `SpareMaker` (session) or `ExecScope`
 * (exec). At most `poolLanes` (4) creations run at once. A spare then
 * sleeps (idle sleep) and nothing wakes it at startup; the take's first
 * message wakes it (157-176 ms in M0).
 *
 * When it fills. The pool is passive until it is first asked for anything
 * (`configure`, `whenSettled`, a take, or a daemon start through
 * `onStart`): provisioning configures it before it fills, so a state that
 * wants no spares (the m1a template) never makes one. After that every take,
 * retire, program change and start tops it up.
 *
 * Restarts. A creation in flight at a restart is abandoned by the next
 * `onStart` (its answers were owed by the host, which broke them): its
 * half-made vat is retired when its facade is known, and the lane is
 * started again. Spares that were ready stay: they are checkpointed
 * sleeping vats.
 *
 * Program changes. A spare made from a digest that is no longer the current
 * program's is retired, never handed out (`programChanged`, and checked
 * again at every take).
 *
 * Failures. A creation that fails (the host refused, the program threw)
 * retires its vat; after `MAX_REFILL_FAILURES` failures in a row of one
 * kind the pool stops refilling that kind until the next `configure`,
 * start, take or program change, so a broken program does not make vats in
 * a loop and `whenSettled()` still settles.
 *
 * Guest rules: prelude globals only; spares in arrays, creations in a
 * `Set`; at most `poolLanes` creations' answered sends in flight.
 */
import { interfaces, shapes } from '../lib/guards/factory.js';
import { limits } from '../lib/limits.js';

/** @import { StartCount } from './starts.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ProgramStore, SessionProgram } from './root.js' */
const { E, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/** Failures in a row of one kind before the pool stops refilling it. */
export const MAX_REFILL_FAILURES = 3;

/** A creation given up by a daemon start (its host answers broke). */
export const ABANDONED_TEXT = 'Spare creation was abandoned by a restart';

/** A take of an exec vat when no exec program was loaded. */
export const NO_EXEC_PROGRAM_TEXT = 'No exec program is loaded';

/**
 * Staging sources for a new worker (data sent to its facade, not code this
 * vat runs; `designs/m1a-interfaces.md` section 9 step 3). The session
 * program's are `factory.js` `stagingSources`; these are the exec
 * program's, whose evaluating crank returns `makeExecScope()`.
 */
export const execStagingSources = harden({
  start: '(globalThis[Symbol.for("harness.exec")] = [], true)',
  push: '(globalThis[Symbol.for("harness.exec")].push(chunk), true)',
  evaluate:
    '(() => { const h = Symbol.for("harness.exec"); const source = globalThis[h].join(""); delete globalThis[h]; return (0, globalThis.eval)(source).makeExecScope(); })()',
});

/**
 * @typedef {{ start: string, push: string, evaluate: string }} StagingSources
 * @typedef {'session' | 'exec'} SpareKind
 */

/**
 * @typedef {object} Spare
 * @property {SpareKind} kind
 * @property {any} facade the worker facade (retire)
 * @property {any} value the `SpareMaker` or the `ExecScope`
 * @property {any} host a session spare's unbound `SessionHostFacet`, minted
 *   with the spare (undefined without `mintHost`, and for exec spares)
 * @property {string} digest the program it was made from
 * @property {string} label the worker's debug label
 */

/**
 * @typedef {object} PoolCreation
 * @property {SpareKind} kind
 * @property {string} digest
 * @property {number} start the daemon start (`starts.js`) it began in
 * @property {any} facade once created
 * @property {boolean} abandoned
 */

/**
 * The pool's settings, kept in the factory heap (operator settings,
 * architecture 9): pool targets and the exec deadline.
 * @param {object} [initial]
 * @param {number} [initial.spareSessions]
 * @param {number} [initial.spareExec]
 * @param {number} [initial.execDeadlineMs]
 */
export const makePoolSettings = ({
  spareSessions = limits.spareSessions,
  spareExec = limits.spareExec,
  execDeadlineMs = limits.execDeadlineMs,
} = {}) => {
  const current = { spareSessions, spareExec, execDeadlineMs };
  return harden({
    spareSessions: () => current.spareSessions,
    spareExec: () => current.spareExec,
    execDeadlineMs: () => current.execDeadlineMs,
    /**
     * @param {{ spareSessions?: number, spareExec?: number, execDeadlineMs?: number }} changes
     *   checked by `shapes.HarnessSettings`
     */
    set: changes => {
      mustMatch(changes, shapes.HarnessSettings);
      if (changes.spareSessions !== undefined)
        current.spareSessions = changes.spareSessions;
      if (changes.spareExec !== undefined)
        current.spareExec = changes.spareExec;
      if (changes.execDeadlineMs !== undefined)
        current.execDeadlineMs = changes.execDeadlineMs;
    },
  });
};
harden(makePoolSettings);

/** @typedef {ReturnType<typeof makePoolSettings>} PoolSettings */

/**
 * @param {object} powers
 * @param {any} powers.vats the worker controller
 * @param {{ session: ProgramStore, exec: ProgramStore }} powers.programs
 * @param {PoolSettings} powers.settings
 * @param {StagingSources} powers.sessionSources the session program's
 *   staging sources (`factory.js` `stagingSources`)
 * @param {number} [powers.lanes] creations in flight at most (default `poolLanes`)
 * @param {() => Promise<any>} [powers.mintHost] mints an unbound
 *   `SessionHostFacet` (`E(admin).forSession()`) for each session spare
 * @param {StartCount} powers.starts the factory's start count (the start
 *   listener raises it before `onStart`)
 */
export const makePool = ({
  vats,
  programs,
  settings,
  sessionSources,
  lanes = limits.poolLanes,
  mintHost,
  starts,
}) => {
  /**
   * Ready spares by kind, oldest first. Maps, not records keyed by kind
   * (guest rule no-data-keys, J-9366).
   * @type {Map<SpareKind, Spare[]>}
   */
  const spares = new Map([
    ['session', []],
    ['exec', []],
  ]);
  /** @param {SpareKind} kind */
  const sparesOf = kind => /** @type {Spare[]} */ (spares.get(kind));
  /** @type {Set<PoolCreation>} creations in flight (pool lanes only) */
  const inflight = new Set();
  /** @type {Record<SpareKind, number>} failures in a row */
  /** @type {Map<SpareKind, number>} */
  const failures = new Map([
    ['session', 0],
    ['exec', 0],
  ]);
  /** @param {SpareKind} kind */
  const failuresOf = kind => /** @type {number} */ (failures.get(kind));
  /** @type {ReturnType<typeof makePromiseKit>[]} */
  let waiters = [];
  let active = false;
  let counter = 0;
  /** Lifetime counts (status, tests). */
  const counts = {
    made: 0,
    taken: 0,
    retired: 0,
    failed: 0,
    abandoned: 0,
    cold: 0,
  };

  /** @param {SpareKind} kind */
  const storeOf = kind => programs[kind];
  /** @param {SpareKind} kind */
  const sourcesOf = kind =>
    kind === 'session' ? sessionSources : execStagingSources;
  /** @param {SpareKind} kind */
  const targetOf = kind =>
    kind === 'session' ? settings.spareSessions() : settings.spareExec();

  /** @param {any} facade */
  const retireFacade = facade => {
    if (facade === undefined) return;
    counts.retired += 1;
    E(facade)
      .retire()
      .catch(() => undefined);
  };

  const status = () =>
    harden({
      spareSessions: sparesOf('session').length,
      spareExec: sparesOf('exec').length,
      refilling: inflight.size,
      target: {
        spareSessions: settings.spareSessions(),
        spareExec: settings.spareExec(),
      },
    });

  const settleWaiters = () => {
    if (inflight.size > 0 || waiters.length === 0) return;
    const now = status();
    const ready = waiters;
    waiters = [];
    for (const waiter of ready) waiter.resolve(now);
  };

  /**
   * Retire spares of a digest that is no longer current, and spares over
   * their target (newest first, so the oldest, most surely checkpointed,
   * stay).
   */
  const discardStale = () => {
    for (const kind of /** @type {SpareKind[]} */ (['session', 'exec'])) {
      const program = storeOf(kind).current();
      const keep = sparesOf(kind).filter(
        spare => program !== undefined && spare.digest === program.digest,
      );
      for (const spare of sparesOf(kind)) {
        if (!keep.includes(spare)) retireFacade(spare.facade);
      }
      const target = targetOf(kind);
      while (keep.length > target) {
        const extra = /** @type {Spare} */ (keep.pop());
        retireFacade(extra.facade);
      }
      spares.set(kind, keep);
    }
  };

  /**
   * Make one vat of `kind` from `program` (S6): create the worker, stage the
   * program, evaluate it. `creation.facade` is set as soon as it exists.
   * @param {SpareKind} kind
   * @param {SessionProgram} program
   * @param {{ facade: any, abandoned: boolean }} creation
   * @param {string} label
   */
  const makeVat = async (kind, program, creation, label) => {
    const sources = sourcesOf(kind);
    const facade = await E(vats).createWorker(label);
    creation.facade = facade;
    if (creation.abandoned) throw Error(ABANDONED_TEXT);
    await E(facade).evaluate(sources.start);
    for (const chunk of program.pieces) {
      if (creation.abandoned) throw Error(ABANDONED_TEXT);
      // eslint-disable-next-line no-await-in-loop
      await E(facade).evaluate(sources.push, harden({ chunk }));
    }
    if (creation.abandoned) throw Error(ABANDONED_TEXT);
    const value = await E(facade).evaluate(sources.evaluate);
    // A session spare carries its unbound SessionHostFacet, minted now, so
    // a take saves the forSession hop (J-0351).
    const host =
      kind === 'session' && mintHost !== undefined
        ? await mintHost()
        : undefined;
    return { value, host };
  };

  /** @param {SpareKind} kind */
  const inflightOf = kind => {
    let n = 0;
    for (const creation of inflight) if (creation.kind === kind) n += 1;
    return n;
  };

  /** The kind the next lane should make, if any. */
  const nextKind = () => {
    for (const kind of /** @type {SpareKind[]} */ (['session', 'exec'])) {
      if (
        storeOf(kind).current() !== undefined &&
        failuresOf(kind) < MAX_REFILL_FAILURES &&
        sparesOf(kind).length + inflightOf(kind) < targetOf(kind)
      )
        return kind;
    }
    return undefined;
  };

  /** Start lanes while below target. Idempotent. */
  const refill = () => {
    if (!active) return;
    discardStale();
    while (inflight.size < lanes) {
      const kind = nextKind();
      if (kind === undefined) break;
      const program = /** @type {SessionProgram} */ (storeOf(kind).current());
      counter += 1;
      const label = `spare ${kind} ${counter}`;
      /** @type {PoolCreation} */
      const creation = {
        kind,
        digest: program.digest,
        start: starts.current(),
        facade: undefined,
        abandoned: false,
      };
      inflight.add(creation);
      makeVat(kind, program, creation, label).then(
        ({ value, host }) => {
          if (creation.abandoned) {
            retireFacade(creation.facade);
            return;
          }
          inflight.delete(creation);
          failures.set(kind, 0);
          counts.made += 1;
          sparesOf(kind).push(
            harden({
              kind,
              facade: creation.facade,
              value,
              host,
              digest: creation.digest,
              label,
            }),
          );
          // A program change or a lower target meanwhile retires it here.
          refill();
          settleWaiters();
        },
        () => {
          if (creation.abandoned) {
            retireFacade(creation.facade);
            return;
          }
          inflight.delete(creation);
          failures.set(kind, failuresOf(kind) + 1);
          counts.failed += 1;
          retireFacade(creation.facade);
          refill();
          settleWaiters();
        },
      );
    }
    settleWaiters();
  };

  /** Clear the failure stops and refill. */
  const restartLanes = () => {
    failures.set('session', 0);
    failures.set('exec', 0);
    active = true;
    refill();
  };

  /**
   * Take the oldest current spare of `kind`, or undefined.
   * @param {SpareKind} kind
   * @returns {Spare | undefined}
   */
  const take = kind => {
    active = true;
    discardStale();
    const spare = sparesOf(kind).shift();
    if (spare !== undefined) counts.taken += 1;
    failures.set(kind, 0);
    refill();
    return spare;
  };

  /**
   * A vat of `kind` made now, outside the pool lanes (a take with no
   * spare): it waits for the whole creation.
   * @param {SpareKind} kind
   */
  const makeCold = async kind => {
    const program = storeOf(kind).current();
    if (program === undefined)
      throw Error(
        kind === 'exec' ? NO_EXEC_PROGRAM_TEXT : 'No session program is loaded',
      );
    counter += 1;
    const label = `${kind} ${counter}`;
    const creation = { facade: undefined, abandoned: false };
    counts.cold += 1;
    try {
      const { value, host } = await makeVat(kind, program, creation, label);
      return harden({
        kind,
        facade: creation.facade,
        value,
        host,
        digest: program.digest,
        label,
      });
    } catch (error) {
      retireFacade(creation.facade);
      throw error;
    }
  };

  return harden({
    /**
     * A spare session `{ facade, value: SpareMaker }`, or undefined (then
     * the factory creates cold, as M1a). The caller makes it and binds it.
     */
    takeSession: () => take('session'),
    /**
     * An exec vat: a spare, else one made now.
     * @returns {Promise<Spare>}
     */
    takeExec: async () => take('exec') ?? makeCold('exec'),
    /** Retire a vat the pool handed out (a lost or reset exec vat). */
    retire: (/** @type {any} */ facade) => {
      retireFacade(facade);
      refill();
    },
    /** Settles with the status when no creation is in flight. */
    whenSettled: () => {
      if (!active) restartLanes();
      const waiter = makePromiseKit();
      waiters.push(waiter);
      settleWaiters();
      return /** @type {Promise<ReturnType<typeof status>>} */ (waiter.promise);
    },
    status,
    /**
     * Apply operator settings (targets, exec deadline) and refill.
     * @param {{ spareSessions?: number, spareExec?: number, execDeadlineMs?: number }} changes
     */
    configure: changes => {
      settings.set(changes);
      restartLanes();
      return status();
    },
    refill,
    /** A program was loaded: retire spares of an older digest, refill. */
    programChanged: () => {
      discardStale();
      failures.set('session', 0);
      failures.set('exec', 0);
      refill();
    },
    /**
     * Every daemon start (the factory's start listener, after it counted
     * the start): abandon creations of earlier starts (their host answers
     * broke) and refill.
     */
    onStart: () => {
      const current = starts.current();
      for (const creation of [...inflight]) {
        if (creation.start < current) {
          creation.abandoned = true;
          inflight.delete(creation);
          counts.abandoned += 1;
          retireFacade(creation.facade);
        }
      }
      restartLanes();
    },
    /** Lifetime counts (tests, diagnostics). */
    counts: () => harden({ ...counts }),
    /** Debug labels of the ready spares (tests). */
    labels: () =>
      harden({
        session: sparesOf('session').map(spare => spare.label),
        exec: sparesOf('exec').map(spare => spare.label),
      }),
  });
};
harden(makePool);

/** @typedef {ReturnType<typeof makePool>} Pool */

/**
 * ExecHandle -> its factory-side control (M2 W2.7: a deleted session's exec
 * vat is retired and the handle closed).
 * @type {WeakMap<any, { close: () => void }>}
 */
const execControls = new WeakMap();

/** The text `ExecHandle.scope()` answers once its session was deleted. */
export const EXEC_CLOSED_TEXT = 'This exec handle belongs to a deleted session';

/**
 * Retire the exec vat a session's ExecHandle leases and close the handle
 * (M2 W2.7 delete step 4). Idempotent; a handle this vat did not make is
 * ignored.
 * @param {any} handle
 */
export const closeExecHandle = handle => {
  execControls.get(handle)?.close();
};
harden(closeExecHandle);

/**
 * The session's exec-vat lease (`interfaces.ExecHandle`): one per
 * session, held only by that session (`SessionServices.execVat`).
 * `scope()` answers the current scope (taking one from the pool the first
 * time and after a retire); `retire(scope)` retires the current one when it
 * is the one named. There is no `run`: the session calls the scope
 * directly (m1b-interfaces.md decision 16.2).
 * @param {object} powers
 * @param {Pool} powers.pool
 * @param {PoolSettings} powers.settings
 */
export const makeExecHandle = ({ pool, settings }) => {
  /** @type {{ scope: any, facade: any } | undefined} */
  let current;
  /** @type {Promise<{ scope: any, facade: any }> | undefined} */
  let taking;
  let closed = false;
  const handle = makeExo('ExecHandle', interfaces.ExecHandle, {
    async scope() {
      if (closed) throw Error(EXEC_CLOSED_TEXT);
      if (current === undefined) {
        if (taking === undefined) {
          taking = pool.takeExec().then(
            spare => {
              if (closed) {
                pool.retire(spare.facade);
                throw Error(EXEC_CLOSED_TEXT);
              }
              const lease = { scope: spare.value, facade: spare.facade };
              current = lease;
              taking = undefined;
              return lease;
            },
            error => {
              taking = undefined;
              throw error;
            },
          );
        }
        await taking;
      }
      const lease = /** @type {{ scope: any, facade: any }} */ (current);
      return harden({
        scope: lease.scope,
        deadlineMs: settings.execDeadlineMs(),
      });
    },
    /** @param {any} scope */
    retire(scope) {
      if (current === undefined || current.scope !== scope) return undefined;
      const { facade } = current;
      current = undefined;
      pool.retire(facade);
      return undefined;
    },
  });
  execControls.set(handle, {
    close: () => {
      closed = true;
      if (current === undefined) return;
      const { facade } = current;
      current = undefined;
      pool.retire(facade);
    },
  });
  return handle;
};
harden(makeExecHandle);
