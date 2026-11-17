// @ts-check
/**
 * The session factory (M1a W1a.6; architecture 3.1, D-4, D-5, D-17;
 * `designs/m1a-interfaces.md` sections 3.4 and 9).
 *
 * `createSession` makes one durable session vat per session, without a pool
 * in M1a: `E(vats).createWorker`, the session program staged in pieces of
 * at most `programPieceBytes` UTF-8 bytes, one evaluating crank whose value
 * is the program's `SpareMaker`, then `make({ config, services,
 * rowReporter })` and `bindSession(host, session)`. Every step is recorded
 * in a creation record in this vat's heap; a failure retires the new vat
 * and drops its row (nothing half-made, R4-6).
 *
 * The start listener (registered with `AgentHostAdmin.onStart` by
 * `main.js`) runs at every daemon start: it completes a creation whose
 * `make` had answered and rolls back every other interrupted creation, then
 * asks each session whose row says `working` for a fresh row snapshot
 * (those sessions are awake anyway: their turn lease broke at the restart,
 * D-5). Idle sessions are never called. A retired break from a session
 * marks its row `lost` (D-17).
 *
 * M1b (W1b.5): with a pool, `createSession` takes a spare session vat
 * (`pool.js`) instead of creating one, then calls `make` and `bindSession`
 * in that order exactly as a cold creation; a spare whose `make` breaks
 * with the retired text is lost, retired and replaced once. Each session
 * gets an `ExecHandle` (`SessionServices.execVat`). The start listener also
 * refreshes the list feed's publisher and restarts the pool's refills; its
 * `attached()` (M1b follow-ups, J-9362) refreshes the publisher after an
 * adapter-only restart. Row
 * changes reach the list feed through the row table (`list-feed.js`).
 *
 * Guest rules: prelude globals only; no clock (`createdAt` is the caller's
 * `CreateOptions.at`, else the latest one the factory saw); answered sends are sequential in a creation and at most
 * `PROBE_WINDOW` at once in the start listener.
 */
import { interfaces, m1bInterfaces, shapes, texts } from '../lib/interfaces.js';
import { isRetiredBreak } from '../lib/retired.js';
import { makeExecHandle } from './pool.js';
import { buildSessionServices } from './services.js';
import { resolveCreateOptions } from './session-options.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable, Row } from './rows.js' */
/** @import { ProgramStore, SessionProgram } from './root.js' */
/** @import { Pool, PoolSettings } from './pool.js' */
/** @import { ListFeed } from './list-feed.js' */
const { E, makeExo } = /** @type {GuestGlobals} */ (globalThis);
/** @type {GuestGlobals['mustMatch']} */
const mustMatch = /** @type {GuestGlobals} */ (globalThis).mustMatch;

/** The built-in preset's label (M1a's only preset, the default). */
export const CHAT_ONLY = 'chat-only';

/**
 * Sources the factory sends to a new worker's facade (data, not code this
 * vat runs; `designs/m1a-interfaces.md` section 9 step 3). The staging slot
 * is a registered symbol, so it is no record key of the new vat.
 */
export const stagingSources = harden({
  start: '(globalThis[Symbol.for("harness.session")] = [], true)',
  push: '(globalThis[Symbol.for("harness.session")].push(chunk), true)',
  evaluate:
    '(() => { const h = Symbol.for("harness.session"); const source = globalThis[h].join(""); delete globalThis[h]; return (0, globalThis.eval)(source).makeSpareMaker(); })()',
});

/** Answered `rowSnapshot` probes in flight at once in the start listener. */
export const PROBE_WINDOW = 32;

/** createSession before provisioning loaded a session program. */
export const NO_PROGRAM_TEXT = 'No session program is loaded';
/** A creation interrupted by a restart and rolled back by the start listener. */
export const INTERRUPTED_CREATION_TEXT =
  'Session creation was interrupted by a restart';

/**
 * @typedef {object} Creation
 * @property {Row} row
 * @property {number} epoch the factory start epoch the creation began in
 * @property {any} facade the new worker's facade, once created
 * @property {{ host: any, backend: any } | undefined} services
 * @property {{ session: any, internal: any } | undefined} made `make`'s answer
 * @property {boolean} fromSpare the vat was a pool spare (M1b)
 * @property {any} [spareHost] the unbound host facet the spare brought (M1b)
 * @property {boolean} finished
 * @property {boolean} abandoned rolled back (by its own failure or the start listener)
 */

/**
 * @param {object} powers
 * @param {any} powers.admin the AgentHostAdmin (`host` grant)
 * @param {any} powers.vats the worker controller (`vats` grant)
 * @param {ProgramStore} powers.programs
 * @param {RowTable} powers.rows
 * @param {() => number} [powers.lastKnownTime] the time a creation without
 *   `at` is stamped with; by default the latest `at` the factory has seen
 * @param {Pool} [powers.pool] the spare pool (M1b W1b.5); without it every
 *   creation is cold and sessions get no `execVat` (M1a)
 * @param {PoolSettings} [powers.settings] the pool's settings (exec deadline)
 * @param {ListFeed} [powers.listFeed] the session list feed (M1b W1b.5)
 */
export const makeFactoryKit = ({
  admin,
  vats,
  programs,
  rows,
  lastKnownTime,
  pool,
  settings,
  listFeed,
}) => {
  /** The latest `CreateOptions.at` seen (vats have no clock: time is data). */
  let latestAt = 0;
  const knownTime = lastKnownTime ?? (() => latestAt);
  const chatOnly = makeExo('Preset', interfaces.Preset, {
    describe: () => harden({ label: CHAT_ONLY, builtIn: true }),
    snapshot: () => harden({ label: CHAT_ONLY }),
  });
  const presets = harden([chatOnly]);

  /** Increased by every daemon start (the start listener). */
  let epoch = 0;
  /** @type {Set<Creation>} creations not yet finished or rolled back */
  const creations = new Set();

  /** @param {Creation} creation */
  const ensureLive = creation => {
    if (creation.abandoned) throw Error(INTERRUPTED_CREATION_TEXT);
  };

  /**
   * Drop the row and retire the new vat. Idempotent.
   * @param {Creation} creation
   */
  const rollBack = async creation => {
    if (creation.abandoned || creation.finished) return;
    creation.abandoned = true;
    creations.delete(creation);
    rows.drop(creation.row);
    if (creation.facade !== undefined) {
      await E(creation.facade)
        .retire()
        .catch(() => undefined);
    }
  };

  /**
   * Steps 4-5 after `make` answered: bind the host facet (idempotent for
   * the same pair), list the row. Idempotent.
   * @param {Creation} creation
   */
  const finish = async creation => {
    const { made, services } = creation;
    if (creation.finished || made === undefined || services === undefined)
      return;
    await E(admin).bindSession(services.host, made.session);
    if (creation.finished || creation.abandoned) return;
    creation.finished = true;
    creations.delete(creation);
    rows.ready(creation.row, made);
  };

  /**
   * Take a spare session vat for this creation (M1b), if the pool has one.
   * @param {Creation} creation
   */
  const takeSpare = creation => {
    const spare = pool?.takeSession();
    if (spare === undefined) return undefined;
    creation.facade = spare.facade;
    creation.fromSpare = true;
    if (spare.host !== undefined) creation.spareHost = spare.host;
    return spare.value;
  };

  /**
   * Stage the session program into a new worker and evaluate it.
   * @param {Creation} creation
   * @param {SessionProgram} program
   */
  const loadProgram = async (creation, program) => {
    const facade = await E(vats).createWorker(`session ${creation.row.key}`);
    creation.facade = facade;
    ensureLive(creation);
    await E(facade).evaluate(stagingSources.start);
    for (const chunk of program.pieces) {
      ensureLive(creation);
      // eslint-disable-next-line no-await-in-loop
      await E(facade).evaluate(stagingSources.push, harden({ chunk }));
    }
    ensureLive(creation);
    const maker = await E(facade).evaluate(stagingSources.evaluate);
    ensureLive(creation);
    return maker;
  };

  /** @param {Record<string, any>} options */
  const createSession = async options => {
    // The caller has the clock (J-9150): its `at` is the session's createdAt.
    const { at } = options;
    if (typeof at === 'number' && at > latestAt) latestAt = at;
    const createdAt = typeof at === 'number' ? at : knownTime();
    const resolved = await resolveCreateOptions(options, {
      defaultPreset: chatOnly,
    });
    const program = programs.current();
    if (program === undefined) throw Error(NO_PROGRAM_TEXT);
    const row = rows.add({
      title: resolved.title,
      backendTitle: resolved.backendTitle,
      modelId: resolved.modelId,
      userInitiated: resolved.userInitiated,
    });
    /** @type {Creation} */
    const creation = {
      row,
      epoch,
      facade: undefined,
      services: undefined,
      made: undefined,
      finished: false,
      abandoned: false,
      fromSpare: false,
    };
    creations.add(creation);
    try {
      // A take is make() then bindSession(), as a cold creation (contract
      // 6.6): the creation-time open the session sends in make() is
      // answered by the manager only after the bind.
      let maker = takeSpare(creation) ?? (await loadProgram(creation, program));
      const services = await buildSessionServices({
        admin,
        backend: resolved.backend,
        preset: resolved.preset,
        key: row.key,
        host: creation.spareHost,
        makeExecVat:
          pool === undefined || settings === undefined
            ? undefined
            : () => makeExecHandle({ pool, settings }),
      });
      ensureLive(creation);
      creation.services = services;
      const config = harden({
        key: row.key,
        title: resolved.title,
        backendTitle: resolved.backendTitle,
        modelId: resolved.modelId,
        preset: resolved.presetSnapshot,
        createdAt,
        userInitiated: resolved.userInitiated,
      });
      mustMatch(config, shapes.SessionConfig);
      const makeArgs = harden({
        config,
        services,
        rowReporter: rows.makeReporter(row),
      });
      /** @type {any} */
      let made;
      try {
        made = await E(maker).make(makeArgs);
      } catch (error) {
        // A lost spare (halted or given up while it slept, D-17): retire
        // it and take the next spare, or create cold, once (contract 7).
        if (!creation.fromSpare || !isRetiredBreak(error)) throw error;
        ensureLive(creation);
        pool?.retire(creation.facade);
        creation.facade = undefined;
        creation.fromSpare = false;
        maker = takeSpare(creation) ?? (await loadProgram(creation, program));
        ensureLive(creation);
        made = await E(maker).make(makeArgs);
      }
      mustMatch(made, shapes.MadeSession);
      ensureLive(creation);
      creation.made = /** @type {{ session: any, internal: any }} */ (made);
      await finish(creation);
      ensureLive(creation);
      return made.session;
    } catch (error) {
      await rollBack(creation);
      throw error;
    }
  };

  const factory = makeExo('SessionFactory', m1bInterfaces.SessionFactory, {
    createSession,
    /** @param {{ after?: string, limit?: number }} [options] */
    listSessions: options => rows.page(options),
    /** @param {string} key */
    findSession: key => {
      const row = rows.get(key);
      if (row === undefined || row.session === undefined)
        throw Error(texts.unknownSession);
      return row.session;
    },
    listPresets: () => presets,
    /** The list rev viewers subscribe from (`Live.subscribeList(rev)`). */
    sessionListFeed: () =>
      harden({ rev: listFeed === undefined ? rows.rev() : listFeed.rev() }),
  });

  const operator = makeExo('Operator', interfaces.Operator, {
    getFactory: () => factory,
  });

  /**
   * Ask a working session for its row; a retired break means its vat is
   * lost (D-17). Other failures leave the row as it was.
   * @param {Row} row
   */
  const probe = async row => {
    try {
      const patch = await E(row.internal).rowSnapshot();
      mustMatch(patch, shapes.RowPatch);
      rows.apply(row, patch);
    } catch (error) {
      if (isRetiredBreak(error)) rows.markLost(row);
    }
  };

  /**
   * Probe rows at most `PROBE_WINDOW` at a time; a probe that never settles
   * (core candidate C-10) holds one slot and never blocks the others.
   * @param {Row[]} targets
   */
  const probeAll = targets =>
    new Promise(resolve => {
      let next = 0;
      let settled = 0;
      if (targets.length === 0) {
        resolve(undefined);
        return;
      }
      const launch = () => {
        if (next >= targets.length) return;
        const row = targets[next];
        next += 1;
        probe(row).finally(() => {
          settled += 1;
          if (settled === targets.length) resolve(undefined);
          launch();
        });
      };
      for (let i = 0; i < PROBE_WINDOW; i += 1) launch();
    });

  /**
   * Every daemon start: finish or roll back interrupted creations, then
   * refresh the rows of sessions that were working.
   */
  const recover = async () => {
    epoch += 1;
    const current = epoch;
    // The previous incarnation's publisher is a tombstone; fetch the new
    // one (not awaited: changes before it answers go unpublished, and
    // viewers of the new incarnation start from the rev anyway).
    void listFeed?.refresh();
    pool?.onStart();
    const interrupted = [...creations].filter(c => c.epoch < current);
    await Promise.all(
      interrupted.map(async creation => {
        if (creation.made === undefined) {
          await rollBack(creation);
          return;
        }
        await finish(creation).catch(() => rollBack(creation));
      }),
    );
    const working = rows
      .all()
      .filter(
        row =>
          row.internal !== undefined &&
          row.state !== 'lost' &&
          row.activity === 'working',
      );
    await probeAll(working);
  };

  /** Settles when the latest start's recovery is done (tests). */
  let recovered = Promise.resolve();

  const startListener = makeExo('StartListener', m1bInterfaces.StartListener, {
    started: () => {
      recovered = recover();
      return undefined;
    },
    /**
     * A new adapter incarnation attached outside a daemon start (an
     * adapter-only restart, J-9362): the list publisher this vat holds is a
     * tombstone, so fetch the current one. Nothing else here holds adapter
     * objects (sessions reopen their own ports, contract 7.1).
     */
    attached: () => {
      void listFeed?.refresh();
      return undefined;
    },
  });

  return harden({
    factory,
    operator,
    presets,
    chatOnly,
    startListener,
    /** The recovery run by the latest `started()` (tests). */
    whenRecovered: () => recovered,
    /** Creations not yet finished or rolled back (tests, status). */
    pendingCreations: () => creations.size,
  });
};
harden(makeFactoryKit);

/** @typedef {ReturnType<typeof makeFactoryKit>} FactoryKit */
