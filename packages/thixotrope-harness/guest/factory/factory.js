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
import { interfaces, shapes, texts } from '../lib/guards/factory.js';
import { fitsFrame } from '../lib/bounded.js';
import { limits } from '../lib/limits.js';
import { isRetiredBreak } from '../lib/retired.js';
import { makeInventory } from './inventory.js';
import { makePresetCatalog } from './presets.js';
import { defaultTemplates } from './preset-templates.js';
import { makeDeletions } from './delete.js';
import { makeFactoryExport } from './export.js';
import { makeExecHandle } from './pool.js';
import { makePostOffice } from './post-office.js';
import { makeOperatorMail } from './operator-mail.js';
import { makeSubagents } from './subagents.js';
import { buildSessionServices } from './services.js';
import { resolveCreateOptions } from './session-options.js';

/** @import { StartCount } from './starts.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable, Row } from './rows.js' */
/** @import { ProgramStore, SessionProgram } from './root.js' */
/** @import { Pool, PoolSettings } from './pool.js' */
/** @import { ListFeed } from './list-feed.js' */
/** @import { HarnessSettings } from './root.js' */
const { E, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);
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
 * @property {number} start the daemon start (`starts.js`) the creation began
 *   in
 * @property {any} facade the new worker's facade, once created
 * @property {{ host: any, backend: any, execVat?: any } | undefined} services
 * @property {{ session: any, internal: any } | undefined} made `make`'s answer
 * @property {boolean} fromSpare the vat was a pool spare (M1b)
 * @property {any} [spareHost] the unbound host facet the spare brought (M1b)
 * @property {boolean} finished
 * @property {boolean} abandoned rolled back (by its own failure or the start listener)
 * @property {any} [prompt] a staged system prompt, released on rollback (M2)
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
 * @param {HarnessSettings} [powers.harnessSettings] the M2 operator settings
 *   (W2.7: backends, default backend and model, turn deadline)
 * @param {StartCount} powers.starts the count of daemon starts, shared with
 *   the pool (`starts.js`)
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
  harnessSettings,
  starts,
}) => {
  /** The latest `CreateOptions.at` seen (vats have no clock: time is data). */
  let latestAt = 0;
  const knownTime = lastKnownTime ?? (() => latestAt);
  // M5 W5.1 (seam H-1): the preset catalogue and the operator inventory.
  const catalog = makePresetCatalog({ templates: defaultTemplates });
  const chatOnly = catalog.builtIn(CHAT_ONLY);
  const inventory = makeInventory();

  /** @type {Set<Creation>} creations not yet finished or rolled back */
  const creations = new Set();
  // M2 W2.7 (m2-interfaces.md 7.1): delete records, completed after restarts.
  // Delete hooks run before step 1's fence, in order: a session's subagents
  // first, deepest first (m9-interfaces.md F5); `subagents` is closed over
  // late (a hook runs only in a delete, after the kit is made).
  const deletions = makeDeletions({
    admin,
    rows,
    starts,
    hooks: harden([
      (/** @type {{ row: Row, session: any }} */ context) =>
        subagents.deleteChildren(context),
    ]),
  });

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
    // M2 (7.2): a staged system prompt of a rolled-back creation.
    if (creation.prompt !== undefined) {
      await E(admin)
        .releaseBlobs(harden([creation.prompt]))
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
    rows.ready(creation.row, made, {
      facade: creation.facade,
      execVat: services.execVat,
    });
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

  /**
   * A creation (contract 9); with `importing` (M2 W2.7, 7.3) its row stays
   * unlisted until the session reports its import's end. With `parent` (a
   * subagent, m9-interfaces.md F3) the row is stored with its parent and
   * never listed, `link(row)` is told of it at once, and `endowments` are
   * the session's only endowments.
   * @param {Record<string, any>} options
   * @param {{ importing?: boolean, parent?: Row, endowments?: readonly { label: string, value: any }[], link?: (row: Row) => void }} how
   */
  const create = async (options, { importing, parent, endowments, link }) => {
    // M5 W5.1 (2.3 step 1): the preset (given or default) and its model
    // defaults, refused here before any row or vat (R4-6).
    const given = catalog.withDefaults(options);
    // The caller has the clock (J-9150): its `at` is the session's createdAt.
    const { at } = given;
    if (typeof at === 'number' && at > latestAt) latestAt = at;
    const createdAt = typeof at === 'number' ? at : knownTime();
    // M2 (R4-21, R4-88; W2.2's resolvers): the operator's default backend
    // and model, and the turn deadline (W2.7).
    /** @type {Record<string, any>} */
    // The admin stages a given system prompt over inlineBytes (W2.6's
    // resolver; W2.9 wiring).
    const context = { defaultPreset: catalog.defaultPreset(), admin };
    if (harnessSettings !== undefined) {
      const defaultBackend = harnessSettings.defaultBackend();
      const defaultModelId = harnessSettings.defaultModelId();
      if (defaultBackend !== undefined) context.defaultBackend = defaultBackend;
      if (defaultModelId !== undefined) context.defaultModelId = defaultModelId;
      context.turnDeadlineMs = harnessSettings.turnDeadlineMs();
    }
    const resolved = await resolveCreateOptions(
      given,
      /** @type {any} */ (harden(context)),
    );
    const program = programs.current();
    if (program === undefined) throw Error(NO_PROGRAM_TEXT);
    const row = rows.add({
      title: resolved.title,
      backendTitle: resolved.backendTitle,
      modelId: resolved.modelId,
      userInitiated: resolved.userInitiated,
      ...(parent === undefined ? {} : { parent }),
    });
    if (importing) rows.setImporting(row, true);
    link?.(row);
    /** @type {Record<string, any>} */
    const extras = resolved;
    /** @type {Creation} */
    const creation = {
      row,
      start: starts.current(),
      facade: undefined,
      services: undefined,
      made: undefined,
      finished: false,
      abandoned: false,
      fromSpare: false,
      prompt:
        typeof extras.systemPrompt === 'object'
          ? extras.systemPrompt.blob
          : undefined,
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
        presetSnapshot: resolved.presetSnapshot,
        key: row.key,
        host: creation.spareHost,
        makeExecVat:
          pool === undefined || settings === undefined
            ? undefined
            : () => makeExecHandle({ pool, settings }),
        // Mail (m9-interfaces.md F2): the row's outbox and delegation.
        row,
        postOffice,
        subagents,
        resolved,
        ...(parent === undefined ? {} : { delegated: endowments ?? [] }),
      });
      ensureLive(creation);
      creation.services = services;
      /** @type {Record<string, any>} */
      const fields = {
        key: row.key,
        title: resolved.title,
        backendTitle: resolved.backendTitle,
        modelId: resolved.modelId,
        preset: catalog.configSnapshot(resolved.presetSnapshot),
        createdAt,
        userInitiated: resolved.userInitiated,
      };
      // Optional creation results a resolver may fill (W2.2 model window,
      // W2.6 prompt, W2.7 turn deadline), copied into the SessionConfig
      // (m2-interfaces.md 1.4), each under a literal key.
      if (extras.systemPrompt !== undefined)
        fields.systemPrompt = extras.systemPrompt;
      if (extras.contextLength !== undefined)
        fields.contextLength = extras.contextLength;
      if (extras.maxOutputTokens !== undefined)
        fields.maxOutputTokens = extras.maxOutputTokens;
      if (extras.turnDeadlineMs !== undefined)
        fields.turnDeadlineMs = extras.turnDeadlineMs;
      if (extras.reasoningEffort !== undefined)
        fields.reasoningEffort = extras.reasoningEffort;
      const config = harden(fields);
      mustMatch(config, shapes.SessionConfig);
      const makeArgs = harden({
        config,
        services,
        rowReporter: rows.makeReporter(row),
      });
      // M5 W5.1 (2.3 step 4): the snapshot and the endowments travel in
      // `make`'s one message (rule 12.5).
      if (!fitsFrame(makeArgs, limits.frameBytes))
        throw Error(texts.presetTooLarge);
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
      return /** @type {{ session: any, internal: any }} */ (made);
    } catch (error) {
      await rollBack(creation);
      throw error;
    }
  };

  // Mail and subagents (m9-interfaces.md F1): the post office, the
  // operator's mailbox (it registers the operator's inbox with the post
  // office, so it is made next) and the subagent tree, which creates
  // children through `create` and deletes them through the delete records.
  const postOffice = makePostOffice({ admin, rows, starts, lastKnownTime });
  const operatorMail = makeOperatorMail({ postOffice, admin, rows });
  /**
   * A delete that dropped its row also drops the row from the post office
   * (its undelivered mail is refused, later mail answers `recipientLost`).
   * @param {Row} row
   */
  const forgetIfDropped = row => {
    if (row.dropped) postOffice.rowRemoved(row);
  };
  /** @param {any} session */
  const deleteSession = session => {
    const row = rows.ofSession(session);
    return deletions.delete(session).finally(() => {
      if (row !== undefined) forgetIfDropped(row);
    });
  };
  const subagents = makeSubagents({
    create,
    deleteSession,
    rows,
    postOffice,
    starts,
    admin,
    settings: {
      current: () => harnessSettings?.current() ?? harden({}),
    },
  });

  /** @param {Record<string, any>} options */
  const createSession = async options =>
    (await create(options, { importing: false })).session;

  /**
   * M2 W2.7: the catalogue of a backend (the request's, else the default,
   * else the first configured), passed through (W2.2 reads it); a lost
   * manager answers `unavailable` (section 11).
   * @param {any} [request] `shapes.ModelRequest`
   */
  const listModels = async (request = {}) => {
    const backend =
      request.backend ??
      harnessSettings?.defaultBackend() ??
      harnessSettings?.backends()[0];
    const unavailable = harden({
      rows: [],
      state: 'unavailable',
      error: texts.catalogUnavailable,
    });
    if (backend === undefined) return unavailable;
    const defaultBackend = harnessSettings?.defaultBackend();
    const defaultModelId = harnessSettings?.defaultModelId();
    /** @type {Record<string, any>} */
    const full = { ...request, backend };
    if (defaultBackend !== undefined) full.defaultBackend = defaultBackend;
    if (defaultModelId !== undefined) full.defaultModelId = defaultModelId;
    // W2.2 widens ModelRequest with the defaults; until then they are left out.
    const forwarded = matches(harden(full), shapes.ModelRequest)
      ? harden(full)
      : harden({ ...request, backend });
    try {
      return await E(backend).listModels(forwarded);
    } catch (error) {
      if (isRetiredBreak(error)) return unavailable;
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
    listPresets: () => catalog.list(),
    /** The list rev viewers subscribe from (`Live.subscribeList(rev)`). */
    sessionListFeed: () =>
      harden({ rev: listFeed === undefined ? rows.rev() : listFeed.rev() }),
    /** @param {any} session M2 W2.7 (m2-interfaces.md 7.1) */
    deleteSession,
    listBackends: () => harnessSettings?.backends() ?? harden([]),
    listModels,
  });

  const operator = makeExo('Operator', interfaces.Operator, {
    getFactory: () => factory,
    /** M2 W2.7: the agent host's Secrets manager (m2-interfaces.md 9). */
    getSecrets: () => E(admin).getSecrets(),
    getPresets: () => catalog.facet,
    getInventory: () => inventory.facet,
    // WX.1: the guard's voice method (m11-interfaces.md H1) refuses until
    // its lane replaces this body (seam H2).
    getMail: () => operatorMail.mailbox,
    getVoice: () => {
      throw Error(texts.notBuiltYet);
    },
  });

  const exports = makeFactoryExport({
    rows,
    settings: {
      current: () => harnessSettings?.current() ?? harden({}),
    },
    create,
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
    // Counted first: the pool and the delete records read it (HR-SYN-36).
    const current = starts.next();
    // The previous incarnation's publisher is a tombstone; fetch the new
    // one (not awaited: changes before it answers go unpublished, and
    // viewers of the new incarnation start from the rev anyway).
    void listFeed?.refresh();
    pool?.onStart();
    const interrupted = [...creations].filter(c => c.start < current);
    await Promise.all(
      interrupted.map(async creation => {
        if (creation.made === undefined) {
          await rollBack(creation);
          return;
        }
        await finish(creation).catch(() => rollBack(creation));
      }),
    );
    // M2 W2.7: an import cut off by the restart is rolled back (7.2), and
    // every delete record completes from its step (7.1, R4-9).
    const resumed = rows.all().filter(row => deletions.isDeleting(row));
    const deleting = deletions.resume().then(() => {
      for (const row of resumed) forgetIfDropped(row);
    });
    for (const row of rows.all()) {
      if (row.importing && row.session !== undefined && !row.dropped) {
        void deleteSession(row.session).catch(() => undefined);
      }
    }
    // Mail (F1): re-drive deliveries cut off by the restart; release or
    // link spawns and close asks cut off by it, after the creations'
    // recovery above. Neither waits for a guest call (CC-110).
    const mail = Promise.all([
      postOffice.restart(current),
      subagents.restart(current),
    ]);
    const working = rows
      .all()
      .filter(
        row =>
          row.internal !== undefined &&
          row.state !== 'lost' &&
          row.state !== 'deleting' &&
          row.activity === 'working',
      );
    await Promise.all([probeAll(working), deleting, mail]);
  };

  /** Settles when the latest start's recovery is done (tests). */
  let recovered = Promise.resolve();

  const startListener = makeExo('StartListener', interfaces.StartListener, {
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
    /** M5 W5.1: the preset catalogue's kit and the inventory's (tests). */
    catalog,
    inventory,
    chatOnly,
    startListener,
    /** The recovery run by the latest `started()` (tests). */
    whenRecovered: () => recovered,
    /** Creations not yet finished or rolled back (tests, status). */
    pendingCreations: () => creations.size,
    deletions,
    exports,
    /** Mail and subagents (tests, status). */
    postOffice,
    operatorMail,
    subagents,
  });
};
harden(makeFactoryKit);

/** @typedef {ReturnType<typeof makeFactoryKit>} FactoryKit */
