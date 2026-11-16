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
 * Guest rules: prelude globals only; no clock (`createdAt` is the factory's
 * last known time); answered sends are sequential in a creation and at most
 * `PROBE_WINDOW` at once in the start listener.
 */
import { interfaces, shapes, texts } from '../lib/interfaces.js';
import { isRetiredBreak } from '../lib/retired.js';
import { buildSessionServices } from './services.js';
import { resolveCreateOptions } from './session-options.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable, Row } from './rows.js' */
/** @import { ProgramStore, SessionProgram } from './root.js' */
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
 * @property {boolean} finished
 * @property {boolean} abandoned rolled back (by its own failure or the start listener)
 */

/**
 * @param {object} powers
 * @param {any} powers.admin the AgentHostAdmin (`host` grant)
 * @param {any} powers.vats the worker controller (`vats` grant)
 * @param {ProgramStore} powers.programs
 * @param {RowTable} powers.rows
 * @param {() => number} [powers.lastKnownTime]
 */
export const makeFactoryKit = ({
  admin,
  vats,
  programs,
  rows,
  lastKnownTime = () => 0,
}) => {
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
    };
    creations.add(creation);
    try {
      const maker = await loadProgram(creation, program);
      const services = await buildSessionServices({
        admin,
        backend: resolved.backend,
        preset: resolved.preset,
        key: row.key,
      });
      ensureLive(creation);
      creation.services = services;
      const config = harden({
        key: row.key,
        title: resolved.title,
        backendTitle: resolved.backendTitle,
        modelId: resolved.modelId,
        preset: resolved.presetSnapshot,
        createdAt: lastKnownTime(),
        userInitiated: resolved.userInitiated,
      });
      mustMatch(config, shapes.SessionConfig);
      const made = await E(maker).make(
        harden({ config, services, rowReporter: rows.makeReporter(row) }),
      );
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

  const factory = makeExo('SessionFactory', interfaces.SessionFactory, {
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

  const startListener = makeExo('StartListener', interfaces.StartListener, {
    started: () => {
      recovered = recover();
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
